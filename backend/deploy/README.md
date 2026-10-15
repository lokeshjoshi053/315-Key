# Deploying to AWS (ECS Fargate)

Every push to `main` that touches `backend/` runs the tests, builds the Docker image, pushes it to ECR and rolls it out to ECS (`.github/workflows/deploy.yml`). A failed test or a failed `/health` check stops the deploy, and the old version keeps running.

```
GitHub push → tests → docker build → ECR → ECS service (Fargate, 1–2 tasks) ← ALB (HTTPS) ← app
                                                 │
                                                 └── RDS Postgres (TLS, same VPC) · S3 (task role) · SSM secrets
```

Why Fargate and not Lambda or App Runner: the API runs background work (hold expiry every 30 s, the push and refund queue every 2 s, the daily 70:30 matching). Lambda can't run it, and App Runner throttles CPU between requests.

## One-time setup

Run these once with the AWS CLI, as an admin of the account. Replace `<ACCOUNT_ID>`, and the VPC, subnet and security-group IDs, with yours. Everything is in `ap-south-1`.

```bash
export AWS_REGION=ap-south-1 ACCOUNT_ID=<ACCOUNT_ID>   # and replace <OWNER>/<REPO> below with the GitHub repo that deploys, e.g. lokeshjoshi053/315-Key
```

### 1. Image registry, logs, file bucket, cluster

```bash
aws ecr create-repository --repository-name plots315-api --image-scanning-configuration scanOnPush=true
aws logs create-log-group --log-group-name /ecs/plots315-api
aws logs put-retention-policy --log-group-name /ecs/plots315-api --retention-in-days 30
aws s3api create-bucket --bucket plots315-docs --create-bucket-configuration LocationConstraint=ap-south-1
aws s3api put-public-access-block --bucket plots315-docs \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws ecs create-cluster --cluster-name plots315
```

S3 bucket names are global; if `plots315-docs` is taken, pick another and change `S3_BUCKET` in `ecs-task-definition.json`.

### 2. Secrets (SSM Parameter Store, encrypted)

Each one is a `SecureString` under `/plots315/prod/`. Use **new** values for production, not your local `.env`.

```bash
put() { aws ssm put-parameter --name "/plots315/prod/$1" --type SecureString --value "$2" --overwrite; }
put DATABASE_URL 'postgres://plots315_app:<strong-password>@key-315.cr422622qf0p.ap-south-1.rds.amazonaws.com:5432/plots315'
put JWT_SECRET "$(openssl rand -base64 48)"
put CRYPTO_KEY "$(openssl rand -base64 32)"      # back this up: losing it makes saved bank details unreadable
put BOOTSTRAP_ADMIN_MOBILE '9xxxxxxxxx'
put MSG91_AUTH_KEY '...'
put MSG91_TEMPLATE_ID '...'
put RAZORPAY_KEY_ID 'rzp_live_...'
put RAZORPAY_KEY_SECRET '...'
put RAZORPAY_WEBHOOK_SECRET '...'
aws ssm put-parameter --name /plots315/prod/FCM_CREDENTIALS_JSON --type SecureString --overwrite \
  --value "file://$HOME/secrets/<your-prod-firebase-key>.json"
```

All ten must exist, or the task won't start. To turn on Google login or Cashfree payouts later, add `GOOGLE_CLIENT_IDS`, `CASHFREE_CLIENT_ID` and `CASHFREE_CLIENT_SECRET` the same way, plus matching entries in the `secrets` list of `ecs-task-definition.json`.

**Database user:** don't run the app as the `postgres` superuser. Connect once and create a dedicated user:

```sql
create user plots315_app with password '<strong-password>';
grant all on database plots315 to plots315_app;
\c plots315
grant all on schema public to plots315_app;
```

### 3. IAM roles

```bash
cat > /tmp/ecs-trust.json <<'EOF'
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow", "Principal": { "Service": "ecs-tasks.amazonaws.com" }, "Action": "sts:AssumeRole" }] }
EOF

# Execution role: lets ECS pull the image, write logs, and read the SSM secrets
aws iam create-role --role-name plots315-ecs-execution --assume-role-policy-document file:///tmp/ecs-trust.json
aws iam attach-role-policy --role-name plots315-ecs-execution --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
aws iam put-role-policy --role-name plots315-ecs-execution --policy-name read-secrets --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{ \"Effect\": \"Allow\", \"Action\": [\"ssm:GetParameters\"], \"Resource\": \"arn:aws:ssm:ap-south-1:$ACCOUNT_ID:parameter/plots315/prod/*\" }]
}"

# Task role: what the running app may do (only the documents bucket)
aws iam create-role --role-name plots315-ecs-task --assume-role-policy-document file:///tmp/ecs-trust.json
aws iam put-role-policy --role-name plots315-ecs-task --policy-name documents-bucket --policy-document '{
  "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject"], "Resource": "arn:aws:s3:::plots315-docs/*" }]
}'
```

### 4. GitHub → AWS without stored keys (OIDC)

```bash
aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1

cat > /tmp/gh-trust.json <<EOF
{ "Version": "2012-10-17", "Statement": [{
  "Effect": "Allow",
  "Principal": { "Federated": "arn:aws:iam::$ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com" },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                      "token.actions.githubusercontent.com:sub": "repo:<OWNER>/<REPO>:environment:production" } } }] }
EOF
aws iam create-role --role-name plots315-github-deploy --assume-role-policy-document file:///tmp/gh-trust.json
aws iam put-role-policy --role-name plots315-github-deploy --policy-name deploy --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    { \"Effect\": \"Allow\", \"Action\": \"ecr:GetAuthorizationToken\", \"Resource\": \"*\" },
    { \"Effect\": \"Allow\", \"Action\": [\"ecr:BatchCheckLayerAvailability\", \"ecr:InitiateLayerUpload\", \"ecr:UploadLayerPart\",
        \"ecr:CompleteLayerUpload\", \"ecr:PutImage\", \"ecr:BatchGetImage\"],
      \"Resource\": \"arn:aws:ecr:ap-south-1:$ACCOUNT_ID:repository/plots315-api\" },
    { \"Effect\": \"Allow\", \"Action\": [\"ecs:RegisterTaskDefinition\", \"ecs:DescribeTaskDefinition\"], \"Resource\": \"*\" },
    { \"Effect\": \"Allow\", \"Action\": [\"ecs:UpdateService\", \"ecs:DescribeServices\"],
      \"Resource\": \"arn:aws:ecs:ap-south-1:$ACCOUNT_ID:service/plots315/plots315-api\" },
    { \"Effect\": \"Allow\", \"Action\": \"iam:PassRole\",
      \"Resource\": [\"arn:aws:iam::$ACCOUNT_ID:role/plots315-ecs-execution\", \"arn:aws:iam::$ACCOUNT_ID:role/plots315-ecs-task\"] }
  ]
}"
```

The thumbprint is a placeholder that AWS no longer checks for GitHub's provider (VERIFY in the IAM console if `create-open-id-connect-provider` complains). If the provider already exists in the account, skip that command.

In GitHub, open **repo → Settings → Environments → New environment `production`**. Add a variable `AWS_ACCOUNT_ID` = your 12-digit account ID. Optionally add yourself as a required reviewer, so every deploy waits for your click.

### 5. Network and load balancer (AWS console is easiest)

1. **Security groups** in the RDS VPC:
   - `plots315-alb`: inbound 443 from anywhere.
   - `plots315-api`: inbound 3000 from `plots315-alb` only.
   - On the **RDS** security group, allow inbound 5432 from `plots315-api` only, and remove any `0.0.0.0/0` or home-IP rule. Then set RDS **Publicly accessible = No**.
2. **Certificate:** ACM → request a public certificate for e.g. `api.315plots.app` (DNS validation).
3. **Load balancer:** EC2 → Load Balancers → Application Load Balancer, internet-facing, the public subnets, SG `plots315-alb`. Use an HTTPS:443 listener with the ACM certificate, forwarding to a target group of **type IP**, port 3000, health check path `/health`. Add HTTP:80 → redirect to 443.
4. **DNS:** point `api.315plots.app` at the ALB (Route 53 alias or a CNAME at your DNS provider).

### 6. First deploy

Register the first task definition and create the service once; GitHub Actions updates it from then on.

```bash
# from backend/: build and push a first image by hand
aws ecr get-login-password | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.ap-south-1.amazonaws.com
docker build --platform linux/amd64 -t $ACCOUNT_ID.dkr.ecr.ap-south-1.amazonaws.com/plots315-api:first .
docker push $ACCOUNT_ID.dkr.ecr.ap-south-1.amazonaws.com/plots315-api:first

sed "s/<ACCOUNT_ID>/$ACCOUNT_ID/g; s#replaced-by-ci#$ACCOUNT_ID.dkr.ecr.ap-south-1.amazonaws.com/plots315-api:first#" \
  deploy/ecs-task-definition.json > /tmp/td.json
aws ecs register-task-definition --cli-input-json file:///tmp/td.json

aws ecs create-service --cluster plots315 --service-name plots315-api --task-definition plots315-api \
  --desired-count 1 --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[<private-subnet-a>,<private-subnet-b>],securityGroups=[<sg-plots315-api>],assignPublicIp=DISABLED}" \
  --load-balancers "targetGroupArn=<target-group-arn>,containerName=api,containerPort=3000" \
  --health-check-grace-period-seconds 90 \
  --deployment-configuration "deploymentCircuitBreaker={enable=true,rollback=true},minimumHealthyPercent=100,maximumPercent=200"
```

Private subnets need a NAT gateway so the app can reach Razorpay, MSG91, Firebase and Cashfree. Without one, use public subnets with `assignPublicIp=ENABLED`; the security groups still restrict inbound traffic.

On first start the container creates the tables, the 5 plans and 315 plots, and makes `BOOTSTRAP_ADMIN_MOBILE` an admin. Check `https://api.315plots.app/health`, then watch logs with `aws logs tail /ecs/plots315-api --follow`.

### 7. After it's live

- **Razorpay:** set the webhook URL to `https://api.315plots.app/webhooks/razorpay` (events `payment.captured`, `payment.failed`, `refund.processed`), and turn on auto-capture.
- **Cashfree:** set the webhook to `https://api.315plots.app/webhooks/cashfree`, and whitelist the NAT gateway's public IP for payouts.
- **App:** point the Kotlin app's base URL at `https://api.315plots.app`.
- **RDS:** enable automated backups (7+ days) and deletion protection.

## Day to day

| Task | How |
| --- | --- |
| Deploy | Push to `main` (or Actions → *Test and deploy API* → Run workflow) |
| Roll back | ECS → service → Update → pick the previous task definition revision; the circuit breaker also auto-rolls back a failed deploy |
| Change a secret | `put NAME value` (above), then ECS → service → **Force new deployment** |
| Logs | `aws logs tail /ecs/plots315-api --follow` |
| Scale | ECS → service → desired count 2; background jobs are safe across tasks |
