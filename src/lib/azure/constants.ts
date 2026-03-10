export const AZURE_API_VERSIONS = {
  subscriptions: "2022-12-01",
  resources: "2022-09-01",
  compute: "2025-04-01",
  network: "2024-10-01",
} as const;

export const AZURE_OS_IMAGES = {
  debian12: {
    publisher: "Debian",
    offer: "debian-12",
    sku: "12-gen2",
    version: "latest",
  },
  debian11: {
    publisher: "Debian",
    offer: "debian-11",
    sku: "11-gen2",
    version: "latest",
  },
  ubuntu22: {
    publisher: "Canonical",
    offer: "0001-com-ubuntu-server-jammy",
    sku: "22_04-lts-gen2",
    version: "latest",
  },
  ubuntu20: {
    publisher: "Canonical",
    offer: "0001-com-ubuntu-server-focal",
    sku: "20_04-lts-gen2",
    version: "latest",
  },
} as const;

export const DEFAULT_VM_ADMIN_USERNAME = "azureuser";
