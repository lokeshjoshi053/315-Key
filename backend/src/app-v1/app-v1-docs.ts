/** Swagger documentation for the mobile app endpoints (/api/v1). Merged into OPS in openapi-docs.ts. */
import type { OpDoc } from '../openapi-docs';

const PLOT = '3b8e6d1a-2c4f-4e9b-a1d7-5f0c8e2b9a33';
const TIER = 'b7a1c3e5-9d2f-4b6a-8e0c-1f3d5a7b9c22';
const U = '6f1c2a8e-4b7d-4f0a-9a3c-2d5e8b1f0a11';
const notPartner: [number, string, string] = [403, 'PARTNER_NOT_APPROVED', 'Partner approval is required'];

const authOk = { success: true, token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI2ZjFj…', role: 'CUSTOMER', errorMessage: null, refreshToken: 'q8V2c1sY9…', expiresIn: 900, isNewUser: true, profileComplete: false };
const plot = {
  id: PLOT, title: 'Plot P-001', block: 'A', facing: 'East', location: '315 PLOTS', sizeSqFt: '1,200 sq ft', pricePerSqFt: '₹4,167/sq ft', roadWidth: '30 ft',
  totalPriceFormatted: '₹50,00,000', status: 'AVAILABLE', imageUrl: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c', latitude: 18.52, longitude: 73.85, mapOffsetX: 0.0333, mapOffsetY: 0.0238,
};
const booking = {
  plotId: PLOT, plotTitle: 'Plot P-001', block: 'A', location: '315 PLOTS', sizeSqFt: '1,200 sq ft', planName: 'Gold', amountFormatted: '₹3,00,000',
  orderId: 'BK-2026-000123', txnId: 'pay_N8yR7mT2b', stepText: 'Step 3 of 4', stepSummary: 'Agreement: in progress',
  milestones: [
    { step: 1, title: 'Plot reserved', subtitle: 'Plot P-001 held for you', status: 'COMPLETED', badgeLabel: 'Done' },
    { step: 2, title: 'Payment', subtitle: '₹3,00,000 received', status: 'COMPLETED', badgeLabel: 'Done' },
    { step: 3, title: 'Agreement', subtitle: 'Agreement sent', status: 'IN_PROGRESS', badgeLabel: 'In progress' },
    { step: 4, title: 'Allotment', subtitle: 'After agreement', status: 'UPCOMING', badgeLabel: 'Upcoming' },
  ],
  bookingId: 'c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e77', status: 'CONFIRMED',
};
const partner = { fullName: 'Asha Patil', phone: '9876543210', email: 'asha@example.com', agentCode: 'P7KQ2XM', referralLink: 'https://315plots.app/r/P7KQ2XM', roleTitle: 'Partner · 315 PLOTS', status: 'Approved', panDocument: '******234F', bankAccount: 'HDFC0001234 · ****9012' };
const commission = { id: 'e9f8a7b6-c5d4-4e3f-8a2b-1c0d9e8f7a66', title: 'Level 1 commission', source: 'BK-2026-000123 · Plot P-001 · Gold', levelRate: '20%', gross: '₹60,000', adminDeduction: '₹12,000', tdsDeduction: '₹3,000', net: '₹45,000', statusBadge: 'Approved' };
const pub = { public: true, status: 200 } as const;

export const APP_V1_OPS: Record<string, OpDoc> = {
  'POST /api/v1/auth/send-otp': { ...pub, summary: 'App: send OTP', description: 'Sends a 6-digit login OTP. Returns AuthResult; on failure success=false with errorMessage (HTTP 429 when rate limited).', body: { phone: '9876543210' }, ok: { description: 'AuthResult', example: { success: true, token: null, role: null, errorMessage: null, expiresInSec: 300, resendAfterSec: 30 } }, errors: [[429, 'OTP_RATE_LIMITED', 'Too many OTP requests, try again in 15 minutes']] },
  'POST /api/v1/auth/resend-otp': { ...pub, summary: 'App: resend OTP', description: 'Same as send-otp.', body: { phone: '9876543210' }, ok: { description: 'AuthResult', example: { success: true, token: null, role: null, errorMessage: null } } },
  'POST /api/v1/auth/verify-otp': { ...pub, summary: 'App: verify OTP and sign in', description: 'token is the access token for `Authorization: Bearer`. role is CUSTOMER, AGENT (approved partner) or ADMIN. Wrong/expired OTP → success=false with errorMessage.', body: { phone: '9876543210', otp: '482913', referralCode: 'P7KQ2XM' }, ok: { description: 'AuthResult', example: authOk } },
  'POST /api/v1/auth/google-login': { ...pub, summary: 'App: Google sign-in', body: { idToken: 'eyJhbGciOiJSUzI1NiIsImtpZCI6…' }, ok: { description: 'AuthResult', example: { ...authOk, isNewUser: false } } },
  'POST /api/v1/auth/firebase-login': { ...pub, summary: 'App: Firebase phone sign-in', description: 'Call after Firebase PhoneAuthProvider signs the user in: send FirebaseUser.getIdToken(). Firebase sends the SMS, so send-otp/verify-otp are not used. Failures → success=false with errorMessage.', body: { idToken: 'eyJhbGciOiJSUzI1NiIsImtpZCI6…', referralCode: 'P7KQ2XM' }, ok: { description: 'AuthResult', example: { ...authOk, isNewUser: true, profileComplete: false } } },
  'POST /api/v1/auth/logout': { ...pub, summary: 'App: log out', description: 'Send the refresh token to revoke it.', body: { refreshToken: 'q8V2c1sY9…' }, ok: { description: 'Logged out', example: { success: true, token: null, role: null, errorMessage: null } } },

  'GET /api/v1/customer/plots': { summary: 'App: all plots', description: 'Plot cards for list and map. status: AVAILABLE, BOOKED, ON_HOLD. mapOffsetX/Y are 0–1 positions on the site map.', ok: { description: 'Plot[]', example: [plot] } },
  'GET /api/v1/customer/plots/{id}': { summary: 'App: plot details', ok: { description: 'Plot', example: plot }, errors: [[404, 'NOT_FOUND', 'Plot not found']] },
  'GET /api/v1/customer/booking-plans': { summary: 'App: booking plans', description: 'amount is in paise (for Razorpay); show amountFormatted.', ok: { description: 'BookingPlan[]', example: [{ id: TIER, name: 'Gold', amount: 30000000, amountFormatted: '₹3,00,000', isPopular: true }] } },
  'POST /api/v1/customer/bookings': {
    summary: 'App: book a plot', description: 'Holds the plot 15 minutes. Open Razorpay Checkout with checkout.razorpayKeyId / razorpayOrderId / amountPaise, then call POST /payments/verify.',
    body: { plotId: PLOT, planId: TIER },
    ok: { description: 'Booking + checkout', example: { ...booking, status: 'PENDING_PAYMENT', checkout: { bookingId: booking.bookingId, bookingRef: 'BK-2026-000123', paymentId: 'd1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f88', paymentRef: 'PAY-2026-000124', amountPaise: 30000000, currency: 'INR', razorpayOrderId: 'order_N8xQ2LkP3a', razorpayKeyId: 'rzp_live_AbC123', holdExpiresAt: '2026-10-22T09:45:00.000Z' } } },
    errors: [[400, 'PROFILE_INCOMPLETE', 'Complete your profile before booking'], [409, 'PLOT_UNAVAILABLE', 'This plot is no longer available'], [409, 'PENDING_BOOKING_EXISTS', 'Finish or cancel your current checkout first'], [502, 'PROVIDER_ERROR', 'Could not start payment, please retry']],
  },
  'GET /api/v1/customer/bookings/active': { summary: 'App: current booking', description: 'The latest booking that is pending payment, confirmed or being refunded. 204 No Content when there is none.', ok: { description: 'Booking', example: booking } },
  'GET /api/v1/customer/payments': { summary: 'App: my payments', ok: { description: 'PaymentItem[]', example: [{ id: 'd1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f88', amountFormatted: '₹3,00,000', dateOrSubtitle: '22 Oct 2026 · PAY-2026-000124', statusBadge: 'Verified' }] } },
  'GET /api/v1/customer/documents': { summary: 'App: my documents', ok: { description: 'DocumentItem[]', example: [{ id: 'f0e1d2c3-b4a5-4968-8776-655443322110', title: 'Sale Agreement', subtitle: 'Agreement · 22 Oct 2026', statusBadge: 'Action needed', isActionNeeded: true }] } },
  'GET /api/v1/customer/notifications': { summary: 'App: customer notifications', ok: { description: 'NotificationItem[]', example: [{ id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c55', title: 'Booking confirmed', timeAgo: '2h ago', iconType: 'booking' }] } },
  'GET /api/v1/customer/profile': { summary: 'App: customer profile', ok: { description: 'UserProfile', example: { fullName: 'Asha Patil', phone: '9876543210', email: 'asha@example.com', nomineeName: 'Rahul Patil', roleTitle: 'Customer' } } },
  'PUT /api/v1/customer/profile': { summary: 'App: save customer profile', description: 'fullName is required before booking. phone is the login and cannot change.', body: { fullName: 'Asha Patil', email: 'asha@example.com', phone: '9876543210', nomineeName: 'Rahul Patil' }, ok: { description: 'UserProfile', example: { fullName: 'Asha Patil', phone: '9876543210', email: 'asha@example.com', nomineeName: 'Rahul Patil', roleTitle: 'Customer' } }, errors: [[400, 'PHONE_CHANGE_NOT_ALLOWED', 'Mobile number is your login and cannot be changed here']] },
  'GET /api/v1/customer/referrer': { summary: 'App: who referred me', description: '204 No Content when the customer has no referrer.', ok: { description: 'ReferrerInfo', example: { agentCode: 'P7KQ2XM', agentName: 'Vikram Shah', agentRole: 'Partner', customerName: 'Asha Patil', customerStatus: 'Booked' } } },

  'GET /api/v1/agent/dashboard/stats': { summary: 'App: partner dashboard', ok: { description: 'DashboardStats', example: { leadsCount: '12', activeLeadsCount: 8, bookingsCount: '3', netCommission: '₹90,000', payoutDue: '₹45,000', matchedVolume: '₹10,000' } }, errors: [notPartner] },
  'GET /api/v1/agent/profile': { summary: 'App: partner profile', description: 'Works before approval too (status shows Pending approval).', ok: { description: 'PartnerProfile', example: partner } },
  'PUT /api/v1/agent/profile': { summary: 'App: update partner profile', body: { fullName: 'Asha Patil', email: 'asha@example.com', phone: '9876543210', address: 'Baner, Pune' }, ok: { description: 'PartnerProfile', example: partner }, errors: [[400, 'PHONE_CHANGE_NOT_ALLOWED', 'Mobile number is your login and cannot be changed here']] },
  'POST /api/v1/agent/onboarding/kyc': { summary: 'App: apply as partner (PAN + bank)', description: 'Stores PAN and bank details encrypted and sets partner status to Pending approval. Bank details are registered for payouts when an admin approves.', body: { pan: 'ABCDE1234F', accountNumber: '123456789012', ifsc: 'HDFC0001234' }, ok: { description: 'PartnerProfile', example: { ...partner, agentCode: '', referralLink: '', roleTitle: 'Partner applicant', status: 'Pending approval' } }, errors: [[400, 'PROFILE_INCOMPLETE', 'Complete your profile first'], [409, 'INVALID_STATE', 'Partner status is APPROVED']] },
  'GET /api/v1/agent/leads': { summary: 'App: my leads', ok: { description: 'Lead[]', example: [{ id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c55', name: 'Neha Shah', phone: '9822000000', plotInterested: 'Corner plot, Block A', statusBadge: 'Registered', subtitle: 'Added 22 Oct 2026' }] }, errors: [notPartner] },
  'POST /api/v1/agent/leads/register': { summary: 'App: register a lead', body: { name: 'Neha Shah', phone: '9822000000', plotInterested: 'Corner plot, Block A' }, ok: { description: 'Lead', example: { id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c55', name: 'Neha Shah', phone: '9822000000', plotInterested: 'Corner plot, Block A', statusBadge: 'New', subtitle: 'Added 22 Oct 2026' } }, errors: [notPartner, [409, 'ALREADY_REGISTERED', 'This mobile number already has an account']] },
  'GET /api/v1/agent/network/levels': { summary: 'App: team size per level', ok: { description: 'NetworkLevel[]', example: [{ level: 1, membersCount: 6 }, { level: 2, membersCount: 9 }, { level: 3, membersCount: 4 }] }, errors: [notPartner] },
  'GET /api/v1/agent/network/tree': { summary: 'App: referral tree (3 levels)', ok: { description: 'TreeNode', example: { id: U, name: 'Asha Patil', subtitle: 'Code P7KQ2XM', badgeText: 'You', level: 0, children: [{ id: '9a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', name: 'Vikram', subtitle: 'Left leg · Joined 22 Oct 2026', badgeText: 'Booked', level: 1, children: [] }] } }, errors: [notPartner] },
  'GET /api/v1/agent/commissions': { summary: 'App: commission list', description: 'Commission and matching entries, newest first; reversals show negative amounts.', ok: { description: 'CommissionItem[]', example: [commission] }, errors: [notPartner] },
  'GET /api/v1/agent/commissions/{id}': { summary: 'App: commission details', ok: { description: 'CommissionItem', example: commission }, errors: [[404, 'NOT_FOUND', 'Commission not found']] },
  'GET /api/v1/agent/matching/summary': { summary: 'App: 70:30 matching', ok: { description: 'MatchingSummary', example: { powerLeg: '₹3,00,000 (Left)', weakerLeg: '₹71,000 (Right)', matchedVolume: '₹10,000', matchedVolShort: '₹10K', gross50: '₹5,000', admin20: '₹1,000', net: '₹3,750' } }, errors: [notPartner] },
  'GET /api/v1/agent/payouts/info': { summary: 'App: payout info', ok: { description: 'PayoutInfo', example: { bankName: 'HDFC ****9012', isVerified: true, nextPayoutAmount: '₹45,000', scheduledDate: 'After admin approval' } }, errors: [notPartner] },
  'GET /api/v1/agent/notifications': { summary: 'App: partner notifications', ok: { description: 'AgentNotification[]', example: [{ id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c55', title: 'Commission earned', timeAgo: '5m ago', type: 'COMMISSION' }] } },

  'GET /api/v1/admin/dashboard/stats': { summary: 'App: admin overview', ok: { description: 'AdminOverviewStats', example: { totalPlots: 315, plotsSold: 3, plotsAvailable: 311, activePartners: 14, pendingApprovals: 2, totalRevenue: '₹9,21,000', pendingPayouts: '₹45,000' } } },
  'GET /api/v1/admin/plots': { summary: 'App: admin plot list', ok: { description: 'Plot[]', example: [plot] } },
  'GET /api/v1/admin/approvals': { summary: 'App: pending partner approvals', description: 'type PARTNER_KYC; id is the user ID.', ok: { description: 'AdminApprovalItem[]', example: [{ id: U, type: 'PARTNER_KYC', title: 'Asha Patil', subtitle: '9876543210 · referred by Vikram', status: 'Pending', submittedAt: '2h ago' }] } },
  'POST /api/v1/admin/approvals/{id}/approve': { status: 200, summary: 'App: approve partner', description: 'Creates the referral code, registers submitted bank details for payouts, notifies the user.', ok: { description: 'Approved', example: { success: true, partnerStatus: 'APPROVED', referralCode: 'P7KQ2XM' } }, errors: [[404, 'NOT_FOUND', 'User not found'], [409, 'INVALID_STATE', 'Cannot approve a APPROVED partner']] },
  'POST /api/v1/admin/approvals/{id}/reject': { status: 200, summary: 'App: reject partner', ok: { description: 'Rejected', example: { success: true, partnerStatus: 'REJECTED', referralCode: null } }, errors: [[404, 'NOT_FOUND', 'User not found'], [409, 'INVALID_STATE', 'Cannot reject a APPROVED partner']] },
  'GET /api/v1/admin/activity-logs': { summary: 'App: admin activity log', ok: { description: 'AdminActivityLog[]', example: [{ id: '1042', title: 'Partner approve', description: 'Admin · user 6f1c2a8e', timeAgo: '5m ago' }] } },
  'GET /api/v1/admin/payouts': { summary: 'App: payout requests', description: 'id "pending:<userId>" = approved commission waiting to be paid (process it); other ids are payouts already sent.', ok: { description: 'AdminPayoutRequest[]', example: [{ id: `pending:${U}`, agentName: 'Asha Patil', agentCode: 'P7KQ2XM', amount: '₹45,000', bankDetails: 'HDFC0001234 · ****9012', period: 'Due now', status: 'Pending' }] } },
  'POST /api/v1/admin/payouts/{id}/process': { status: 200, summary: 'App: send a payout', description: 'Pays a pending request through Cashfree.', ok: { description: 'Batch result', example: { success: true, created: 1, results: [{ userId: U, payoutRef: 'PO-2026-000210', amountPaise: 4500000, status: 'PROCESSING' }] } }, errors: [[400, 'NOTHING_TO_PAY', 'No approved amount above the minimum, or bank details are missing'], [409, 'ALREADY_PROCESSED', 'This payout was already sent']] },
};
