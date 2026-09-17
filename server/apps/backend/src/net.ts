import { networkInterfaces } from "node:os";

/**
 * 局域网访问地址探测。
 *
 * 服务端默认监听 `0.0.0.0`，同一 WiFi 下的手机/平板可以直接访问；
 * 但用户需要知道**该填哪个 IP**——本机往往装了一堆虚拟网卡
 * （VMware / VirtualBox / Hyper-V / WSL / Docker），全部列出来只会让人更迷惑。
 * 所以这里做一次筛选并排序。
 */

export interface LanAddress {
  readonly name: string;
  readonly address: string;
}

export type NetworkInterfaceMap = ReturnType<typeof networkInterfaces>;

/** 明显是虚拟网卡的接口名，局域网访问列表里排除。 */
const VIRTUAL_ADAPTER =
  /(vmware|virtualbox|vbox|hyper-?v|vethernet|wsl|docker|loopback|zerotier|tailscale|radmin|hamachi|bluetooth)/i;

/** 更可能是真实局域网出口的网卡（Wi-Fi / 以太网），排在前面。 */
const PREFERRED_ADAPTER = /(wi-?fi|wlan|wireless|ethernet|以太网|无线)/i;

/**
 * 从网卡列表里挑出可用于局域网访问的 IPv4 地址（纯函数，便于测试）。
 *
 * 过滤规则：内部地址、APIPA 自分配地址（169.254.x.x）、明显虚拟的网卡；
 * 真实网卡（Wi-Fi / 以太网）排在前面，其余非虚拟网卡随后。
 */
export function pickLanAddresses(interfaces: NetworkInterfaceMap): LanAddress[] {
  const preferred: LanAddress[] = [];
  const others: LanAddress[] = [];

  for (const [name, addresses] of Object.entries(interfaces)) {
    if (addresses === undefined) {
      continue;
    }

    const isVirtual = VIRTUAL_ADAPTER.test(name);

    for (const info of addresses) {
      if (info.family !== "IPv4" || info.internal) {
        continue;
      }

      // 169.254.x.x 是拿不到 DHCP 时 Windows 的自分配地址，连不通
      if (info.address.startsWith("169.254.")) {
        continue;
      }

      const entry: LanAddress = { name, address: info.address };
      if (isVirtual) {
        continue;
      }

      if (PREFERRED_ADAPTER.test(name)) {
        preferred.push(entry);
      } else {
        others.push(entry);
      }
    }
  }

  return [...preferred, ...others];
}

/** 当前机器的局域网访问地址。 */
export function listLanAddresses(): LanAddress[] {
  return pickLanAddresses(networkInterfaces());
}
