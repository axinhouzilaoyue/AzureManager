export const AZURE_API_VERSIONS = {
  subscriptions: "2022-12-01",
  resources: "2022-09-01",
  providers: "2021-04-01",
  compute: "2025-04-01",
  network: "2024-10-01",
  authorization: "2022-04-01",
  costManagement: "2023-11-01",
  cognitiveServices: "2025-10-01-preview",
} as const;

export const AZURE_OS_IMAGES = {
  debian12: {
    x64: { publisher: "Debian", offer: "debian-12", sku: "12-gen2", version: "latest" },
    arm64: { publisher: "Debian", offer: "debian-12", sku: "12-arm64-gen2", version: "latest" },
  },
  debian11: {
    x64: { publisher: "Debian", offer: "debian-11", sku: "11-backports-gen2", version: "latest" },
    arm64: { publisher: "Debian", offer: "debian-11", sku: "11-backports-arm64-gen2", version: "latest" },
  },
  ubuntu24: {
    x64: { publisher: "Canonical", offer: "ubuntu-24_04-lts", sku: "server-gen2", version: "latest" },
    arm64: { publisher: "Canonical", offer: "ubuntu-24_04-lts", sku: "server-arm64", version: "latest" },
  },
  ubuntu22: {
    x64: { publisher: "Canonical", offer: "0001-com-ubuntu-server-jammy", sku: "22_04-lts-gen2", version: "latest" },
    arm64: { publisher: "Canonical", offer: "0001-com-ubuntu-server-jammy", sku: "22_04-lts-arm64", version: "latest" },
  },
  ubuntu20: {
    x64: { publisher: "Canonical", offer: "0001-com-ubuntu-server-focal", sku: "20_04-lts-gen2", version: "latest" },
    arm64: { publisher: "Canonical", offer: "0001-com-ubuntu-server-focal", sku: "20_04-lts-arm64", version: "latest" },
  },
  centos8: {
    x64: { publisher: "OpenLogic", offer: "CentOS", sku: "8_5-gen2", version: "latest" },
  },
} as const;

export const DEFAULT_VM_ADMIN_USERNAME = "azureuser";

export function isArm64VmSize(vmSize: string): boolean {
  const normalized = vmSize.toLowerCase();
  return normalized.includes("arm") || normalized.includes("pts") || normalized.includes("ps");
}

export function resolveAzureOsImage(osImage: keyof typeof AZURE_OS_IMAGES, vmSize: string) {
  const images = AZURE_OS_IMAGES[osImage];
  if (isArm64VmSize(vmSize)) {
    if ("arm64" in images) return images.arm64;
    throw new Error(`image_arm64_not_supported:${osImage}`);
  }
  return images.x64;
}
