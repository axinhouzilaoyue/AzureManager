export type JsonRecord = Record<string, unknown>;

export type TaskStatus = "queued" | "running" | "success" | "failure";

export type VmAction = "start" | "stop" | "restart" | "delete";

export type WorkflowName =
  | "create-vm-workflow"
  | "vm-lifecycle-workflow"
  | "change-ip-workflow";

export interface WorkflowInstanceStatus {
  status:
    | "queued"
    | "running"
    | "paused"
    | "errored"
    | "terminated"
    | "complete"
    | "waiting"
    | "waitingForPause"
    | "unknown";
  error?: {
    name: string;
    message: string;
  };
  output?: unknown;
}

export interface WorkflowInstanceHandle {
  id: string;
  status(): Promise<WorkflowInstanceStatus>;
  sendEvent?(event: { type: string; payload?: unknown }): Promise<void>;
}

export interface WorkflowBinding<TParams = unknown> {
  create(options?: { id?: string; params?: TParams }): Promise<WorkflowInstanceHandle>;
  get(id: string): Promise<WorkflowInstanceHandle>;
}

export interface SessionState {
  v: 1;
  selectedAccountId: string | null;
  localAuthExp: number | null;
}

export interface AuthContext {
  authenticated: boolean;
  actor: string;
  session: SessionState;
}

export interface AccountRecord {
  id: string;
  name: string;
  clientId: string;
  tenantId: string;
  subscriptionId: string;
  clientSecretCiphertext: string;
  expirationDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DecryptedAccountRecord extends Omit<AccountRecord, "clientSecretCiphertext"> {
  clientSecret: string;
}

export interface AccountSummary {
  id: string;
  name: string;
  clientId: string;
  tenantId: string;
  subscriptionId: string;
  expirationDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountCheckResult {
  subscriptionDisplayName: string;
  state: string;
  availableRegionCount: number;
  warnings: string[];
  checkedAt: string;
}

export interface TaskRecord {
  id: string;
  accountId: string;
  type: string;
  status: TaskStatus;
  workflowName: WorkflowName;
  workflowInstanceId: string | null;
  lockKey: string | null;
  message: string | null;
  resultJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  idempotencyKey: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface TaskLogRecord {
  id: number;
  taskId: string;
  step: string;
  level: string;
  message: string;
  detailJson: string | null;
  createdAt: string;
}

export interface TaskResponse {
  id: string;
  status: TaskStatus;
  message: string | null;
  result: JsonRecord | string | null;
  errorCode: string | null;
  errorMessage: string | null;
  workflowName: WorkflowName;
  workflowInstanceId: string | null;
  logs: Array<{
    id: number;
    step: string;
    level: string;
    message: string;
    detail: unknown;
    createdAt: string;
  }>;
}

export interface AzureVmSummary {
  name: string;
  location: string;
  vmSize: string;
  status: string;
  resourceGroup: string;
  publicIp: string;
  timeCreated: string | null;
}

export interface CreateVmParams {
  taskId: string;
  accountId: string;
  actor: string;
  region: string;
  vmSize: string;
  osImage: "debian12" | "debian11" | "ubuntu22" | "ubuntu20";
  diskSize: number;
  ipType: "Static" | "Dynamic";
  userData: string | null;
}

export interface VmLifecycleParams {
  taskId: string;
  accountId: string;
  actor: string;
  action: VmAction;
  resourceGroup: string;
  vmName: string;
}

export interface ChangeIpParams {
  taskId: string;
  accountId: string;
  actor: string;
  resourceGroup: string;
  vmName: string;
}

export interface AppEnv {
  APP_NAME: string;
  SESSION_TTL_SECONDS: number | string;
  LOCK_TIMEOUT_SECONDS: number | string;
  AZURE_ARM_BASE_URL: string;
  AZURE_AUTH_BASE_URL: string;
  APP_PASSWORD?: string;
  SESSION_SECRET: string;
  ACCOUNT_ENCRYPTION_KEY: string;
  DB: D1Database;
  ASSETS: Fetcher;
  SUBSCRIPTION_LOCK: DurableObjectNamespace;
  CREATE_VM_WORKFLOW: WorkflowBinding<CreateVmParams>;
  VM_LIFECYCLE_WORKFLOW: WorkflowBinding<VmLifecycleParams>;
  CHANGE_IP_WORKFLOW: WorkflowBinding<ChangeIpParams>;
}
