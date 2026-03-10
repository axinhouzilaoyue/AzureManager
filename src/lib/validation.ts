import { z } from "zod";

export const loginSchema = z.object({
  password: z.string().min(1, "密码不能为空"),
});

export const createAccountSchema = z.object({
  name: z.string().trim().min(1, "账户名称不能为空").max(120, "账户名称过长"),
  clientId: z.string().trim().uuid("客户端 ID 格式无效"),
  clientSecret: z.string().trim().min(1, "客户端密码不能为空"),
  tenantId: z.string().trim().uuid("租户 ID 格式无效"),
  subscriptionId: z.string().trim().uuid("订阅 ID 格式无效"),
  expirationDate: z
    .string()
    .trim()
    .min(1)
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional()
    .transform((value) => value ?? null),
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
  expirationDate: z
    .string()
    .trim()
    .min(1)
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional()
    .transform((value) => value ?? null),
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

export const createVmSchema = z.object({
  region: z.string().trim().min(1, "区域不能为空"),
  vmSize: z.string().trim().min(1, "实例类型不能为空"),
  osImage: z.enum(["debian12", "debian11", "ubuntu22", "ubuntu20"]),
  diskSize: z.number().int().min(30).max(1024),
  ipType: z.enum(["Static", "Dynamic"]),
  userData: z.string().trim().max(32768).nullable(),
});

export const updateStartupScriptSchema = z.object({
  userData: z.string().max(32768, "开机脚本过长"),
});
