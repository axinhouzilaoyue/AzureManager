import { z } from "zod";

export const loginSchema = z.object({
  password: z.string().min(1, "密码不能为空"),
});

const optionalDate = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式无效").nullable().optional(),
);

const optionalEmail = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z.string().trim().email("邮箱格式无效").max(200, "邮箱过长").nullable().optional(),
);

export const createAccountSchema = z.object({
  name: z.string().trim().min(1, "账户名称不能为空").max(120, "账户名称过长"),
  clientId: z.string().trim().uuid("客户端 ID 格式无效"),
  clientSecret: z.string().trim().min(1, "客户端密码不能为空"),
  tenantId: z.string().trim().uuid("租户 ID 格式无效"),
  subscriptionId: z.string().trim().uuid("订阅 ID 格式无效"),
  email: optionalEmail,
  expirationDate: optionalDate,
});

export const accountCheckSchema = z.object({
  clientId: z.string().trim().uuid("客户端 ID 格式无效"),
  clientSecret: z.string().trim().min(1, "客户端密码不能为空"),
  tenantId: z.string().trim().uuid("租户 ID 格式无效"),
  subscriptionId: z.string().trim().uuid("订阅 ID 格式无效"),
});

export const editAccountSchema = z.object({
  accountId: z.string().uuid("账户 ID 格式无效"),
  newName: z.string().trim().min(1, "新的账户名称不能为空").max(120, "账户名称过长"),
  email: optionalEmail,
  expirationDate: optionalDate,
});

export const selectAccountSchema = z.object({
  accountId: z.string().uuid("账户 ID 格式无效").nullable(),
});

export const vmActionSchema = z.object({
  action: z.enum(["start", "stop", "restart", "delete"]),
  resourceGroup: z.string().trim().min(1, "资源组不能为空"),
  vmName: z.string().trim().min(1, "虚拟机名称不能为空"),
});

export const changeIpSchema = z.object({
  resourceGroup: z.string().trim().min(1, "资源组不能为空"),
  vmName: z.string().trim().min(1, "虚拟机名称不能为空"),
});

const optionalTrimmedString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z.string().trim().nullable().optional(),
);

const vmNameSchema = optionalTrimmedString.refine(
  (value) => value === null || value === undefined || /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?$/.test(value),
  "虚拟机名称只能包含字母、数字和短横线，且必须以字母或数字开头结尾",
);

const adminUsernameSchema = optionalTrimmedString.refine(
  (value) => value === null || value === undefined || /^[a-z_][a-z0-9_-]{0,31}$/.test(value),
  "用户名需以小写字母或下划线开头，只允许小写字母、数字、下划线和短横线",
);

function isAzurePassword(value: string): boolean {
  if (value.length < 12 || value.length > 72) return false;
  const groups = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(value)).length;
  return groups >= 3;
}

const adminPasswordSchema = optionalTrimmedString.refine(
  (value) => value === null || value === undefined || isAzurePassword(value),
  "密码需为 12～72 个字符，并至少包含小写字母、大写字母、数字、特殊字符中的三类",
);

export const createVmSchema = z.object({
  region: z.string().trim().min(1, "区域不能为空"),
  vmSize: z.string().trim().min(1, "实例类型不能为空"),
  osImage: z.enum(["debian12", "debian11", "ubuntu24", "ubuntu22", "ubuntu20", "centos8"]),
  diskSize: z.number().int().refine(
    (value) => [30, 32, 64, 128, 256, 512, 1024, 2048].includes(value),
    "磁盘大小仅支持 30、32、64、128、256、512、1024、2048 GB",
  ),
  diskType: z.enum(["Premium_LRS", "StandardSSD_LRS", "Standard_LRS"]),
  ipType: z.enum(["Static", "Dynamic"]),
  userData: z.string().trim().max(32768).nullable(),
  vmName: vmNameSchema,
  adminUsername: adminUsernameSchema,
  adminPassword: adminPasswordSchema,
  useGlobalSsh: z.boolean().default(false),
  enableRoot: z.boolean().default(false),
  nsgEnabled: z.boolean().default(true),
  nsgPorts: z.array(z.number().int().min(1).max(65535)).max(20).default([22]),
  nsgOpenAllInbound: z.boolean().default(false),
  nsgOpenAllOutbound: z.boolean().default(false),
}).superRefine((value, ctx) => {
  if (value.diskSize === 30 && value.diskType === "Premium_LRS") {
    ctx.addIssue({
      code: "custom",
      path: ["diskSize"],
      message: "30 GB 不支持 Premium SSD，请选择 32 GB 或更换磁盘类型",
    });
  }
});

export const updateStartupScriptSchema = z.object({
  userData: z.string().max(32768, "开机脚本过长"),
});

export const updateGlobalSshSchema = z.object({
  publicKey: z.string().trim().max(16384, "SSH 公钥过长").refine(
    (value) => !value || /^(ssh-rsa|ssh-ed25519|ecdsa-[a-z0-9-]+)\s+/.test(value),
    "SSH 公钥格式无效",
  ),
  username: z.string().trim().max(64, "SSH 用户名过长").refine(
    (value) => !value || /^[a-z_][a-z0-9_-]{0,31}$/.test(value),
    "SSH 用户名需以小写字母或下划线开头，只允许小写字母、数字、下划线和短横线",
  ),
  password: z.string().max(256, "SSH 密码过长"),
});

export const reorderAccountsSchema = z.object({
  accountIds: z.array(z.string().uuid("账户 ID 格式无效")).min(1, "账户列表不能为空").max(200, "账户数量过多"),
});

export const importAccountsSchema = z.object({
  data: z.unknown(),
});
