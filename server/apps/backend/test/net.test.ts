import { describe, expect, it } from "vitest";
import { pickLanAddresses, type NetworkInterfaceMap } from "../src/net";

/**
 * 局域网地址筛选：本机常装一堆虚拟网卡，必须选出真正能连的那个。
 */

function iface(
  entries: Record<string, Array<{ address: string; family?: string; internal?: boolean }>>,
): NetworkInterfaceMap {
  const result: Record<string, Array<{ address: string; family: string; internal: boolean; netmask: string; mac: string; cidr: string | null }>> = {};
  for (const [name, list] of Object.entries(entries)) {
    result[name] = list.map((item) => ({
      address: item.address,
      family: item.family ?? "IPv4",
      internal: item.internal ?? false,
      netmask: "255.255.255.0",
      mac: "00:00:00:00:00:00",
      cidr: `${item.address}/24`,
    }));
  }

  return result as unknown as NetworkInterfaceMap;
}

describe("局域网地址筛选", () => {
  it("排除虚拟网卡（VMware / VirtualBox / Hyper-V / WSL / Docker）", () => {
    const picked = pickLanAddresses(
      iface({
        "WLAN 2": [{ address: "192.168.1.147" }],
        "VMware Network Adapter VMnet1": [{ address: "192.168.74.1" }],
        "VMware Network Adapter VMnet8": [{ address: "192.168.164.1" }],
        "vEthernet (WSL)": [{ address: "172.20.16.1" }],
        "Hyper-V Virtual Ethernet Adapter": [{ address: "172.28.0.1" }],
        "Docker Desktop": [{ address: "172.30.0.1" }],
      }),
    );

    expect(picked).toEqual([{ name: "WLAN 2", address: "192.168.1.147" }]);
  });

  it("排除回环地址与 APIPA 自分配地址", () => {
    const picked = pickLanAddresses(
      iface({
        Loopback: [{ address: "127.0.0.1", internal: true }],
        Ethernet: [
          { address: "169.254.10.20" },
          { address: "10.0.0.8" },
        ],
      }),
    );

    expect(picked).toEqual([{ name: "Ethernet", address: "10.0.0.8" }]);
  });

  it("排除非 IPv4 地址", () => {
    const picked = pickLanAddresses(
      iface({
        "Wi-Fi": [
          { address: "fe80::1", family: "IPv6" },
          { address: "192.168.0.5" },
        ],
      }),
    );

    expect(picked).toEqual([{ name: "Wi-Fi", address: "192.168.0.5" }]);
  });

  it("真实网卡排在前面（Wi-Fi / 以太网优先）", () => {
    const picked = pickLanAddresses(
      iface({
        "Some Bridge": [{ address: "192.168.50.2" }],
        "Wi-Fi": [{ address: "192.168.1.147" }],
        Ethernet: [{ address: "10.0.0.8" }],
      }),
    );

    expect(picked.map((item) => item.address)).toEqual(["192.168.1.147", "10.0.0.8", "192.168.50.2"]);
  });

  it("多个真实网卡时都列出（用户自行选择）", () => {
    const picked = pickLanAddresses(
      iface({
        "Wi-Fi": [{ address: "192.168.1.147" }],
        Ethernet: [{ address: "10.0.0.8" }],
      }),
    );

    expect(picked).toHaveLength(2);
  });

  it("没有任何可用地址时返回空数组（不抛错）", () => {
    expect(pickLanAddresses(iface({ Loopback: [{ address: "127.0.0.1", internal: true }] }))).toEqual([]);
    expect(pickLanAddresses({} as NetworkInterfaceMap)).toEqual([]);
    // 网卡值为 undefined 的条目（Node 类型允许）也要跳过
    expect(pickLanAddresses({ "Wi-Fi": undefined } as unknown as NetworkInterfaceMap)).toEqual([]);
  });
});
