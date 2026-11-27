import type { WorkspaceSiteAccountVerification, WorkspaceVerificationReason } from './types';

export const loginStateLabels: Record<WorkspaceSiteAccountVerification['state'], string> = {
  pending: '待驗證', running: '驗證中', verified: '已通過驗證', failed: '驗證失敗',
};

export const loginVerificationReasons: Record<WorkspaceVerificationReason, string> = {
  scope_confirmation_required: '請先確認提案範圍。',
  login_setup_required: '請在訪談補齊登入入口、表單欄位與登入後成功條件。',
  credentials_required: '請到「登入資料」為此帳號保存帳密。',
  unsupported_login_method: '目前支援帳密表單。此站使用的登入方式待支援。',
  login_rejected: '登入資料遭站台拒絕。請更新帳密後重試。',
  mfa_required: '站台要求多因素驗證。請在訪談調整可用的測試登入方式。',
  guest_accessible: '訪客也能通過目前的成功條件。請在訪談指定受保護的頁面或可區別登入者的內容。',
  login_not_verified: '登入後未觀察到成功條件。請檢查登入入口與站台的成功條件。',
  credential_unavailable: '登入資料已變更或目前不可用。請檢查登入資料後重試。',
  invalid_evidence: 'Server 無法採用這次驗證結果。請重新驗證。',
  timed_out: '登入驗證逾時。請檢查站台是否可正常載入後重試。',
  cancelled: '登入驗證已取消。',
  interrupted: '登入驗證中斷。請重新驗證。',
};
