import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Controller, Get, Inject, Injectable, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { CONFIG, Config } from '../config';
import { Db } from '../db';
import { AuthUser, CurrentUser } from '../common/auth';
import { ApiException, notFound, PageQuery } from '../common/http';

/** Private bucket (S3 / R2 / MinIO). Files are never public; access is a 5-minute signed URL (C8). */
@Injectable()
export class Storage {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(@Inject(CONFIG) cfg: Config) {
    this.bucket = cfg.s3.bucket;
    this.s3 = new S3Client({
      region: cfg.s3.region,
      ...(cfg.s3.endpoint ? { endpoint: cfg.s3.endpoint, forcePathStyle: true } : {}),
      ...(cfg.s3.accessKey ? { credentials: { accessKeyId: cfg.s3.accessKey, secretAccessKey: cfg.s3.secretKey } } : {}),
    });
  }

  async put(key: string, body: Buffer, contentType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: 'AES256' }));
  }

  signedUrl(key: string, ttlSec = 300) {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: ttlSec });
  }
}

@ApiTags('Documents')
@ApiBearerAuth()
@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly db: Db,
    private readonly storage: Storage,
  ) {}

  /** C12 */
  @Get()
  async list(@CurrentUser() u: AuthUser, @Query() q: PageQuery) {
    const items = await this.db.many(
      `select d.id, d.type, d.title, d.status, d.created_at, d.updated_at, b.internal_ref as booking_ref
       from document d left join booking b on b.id = d.booking_id
       where d.user_id = $1 order by d.created_at desc limit $2 offset $3`,
      [u.id, q.size, q.page * q.size],
    );
    const { total } = await this.db.one<{ total: number }>('select count(*) as total from document where user_id = $1', [u.id]);
    return { items, page: q.page, size: q.size, total };
  }

  @Get(':id/url')
  async url(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const d = await this.db.maybe<{ storageKey: string }>('select storage_key from document where id = $1 and user_id = $2', [id, u.id]);
    if (!d) throw notFound('Document');
    return { url: await this.storage.signedUrl(d.storageKey), expiresInSec: 300 };
  }

  /** eSign provider not chosen yet (VERIFY Leegality/Digio). Admin marks status manually until then. */
  @Post(':id/sign')
  sign() {
    throw new ApiException(501, 'ESIGN_NOT_CONFIGURED', 'Online signing is not available yet');
  }
}
