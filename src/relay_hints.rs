#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn address_ranges_and_hosts() {
        for a in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.0.2.1",
            "192.168.0.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "ff02::1",
            "2001:db8::1",
            "64:ff9b::127.0.0.1",
            "::ffff:7f00:1",
        ] {
            assert!(private_address(a), "{a}");
        }
        for a in [
            "8.8.8.8",
            "100.63.255.255",
            "172.32.0.1",
            "2606:4700::1111",
            "::ffff:8.8.8.8",
        ] {
            assert!(!private_address(a), "{a}");
        }
        for h in [
            "localhost.",
            "foo.localhost",
            "foo.LOCAL.",
            "foo.internal",
            "foo.home.arpa",
            "foo.lan",
        ] {
            assert!(blocked_hostname(h));
        }
    }
    #[test]
    fn sanitize() {
        let hints = [
            "wss://localhost/",
            "wss://user:pw@example.com/",
            "http://example.com",
            "wss://relay.example.com/#frag",
            "wss://relay.example.com",
            "wss://8.8.8.8/",
        ]
        .map(str::to_string);
        assert_eq!(
            sanitize_relay_hints(&hints),
            vec!["wss://relay.example.com/", "wss://8.8.8.8/"]
        );
    }
    #[tokio::test]
    async fn dns_fails_closed() {
        assert!(
            resolve_safe_relay_hints(&["wss://this-host-does-not-exist.invalid/".into()])
                .await
                .is_empty()
        );
        assert_eq!(
            resolve_safe_relay_hints(&["wss://8.8.8.8/".into()]).await,
            vec!["wss://8.8.8.8/"]
        );
    }
    #[test]
    fn oracle_address_and_policy_tables() {
        for a in [
            "0.255.255.255",
            "10.255.255.255",
            "100.127.255.255",
            "127.255.255.255",
            "169.254.0.1",
            "172.31.255.255",
            "192.0.0.1",
            "192.168.255.255",
            "198.19.255.255",
            "239.255.255.255",
            "240.0.0.1",
            "255.255.255.255",
            "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
            "febf::1",
            "ff00::1",
            "[::ffff:127.0.0.1]",
            "::127.0.0.1",
        ] {
            assert!(private_address(a), "{a}");
        }
        for a in [
            "1.1.1.1",
            "100.128.0.1",
            "169.253.0.1",
            "172.15.0.1",
            "192.0.1.1",
            "192.0.3.1",
            "198.20.0.1",
            "203.0.114.1",
            "223.255.255.255",
            "2001:4860:4860::8888",
            "2400:cb00::1",
            "64:ff9b::1.1.1.1",
            "::8.8.8.8",
            "localhost",
            "10.0.0",
            "999.1.1.1",
            "1:2:3:4:5:6:7",
        ] {
            assert!(!private_address(a), "{a}");
        }
        for h in [
            "localhost",
            "LOCALHOST",
            "foo.localhost",
            "foo.local",
            "foo.internal",
            "foo.home.arpa",
            "foo.lan.",
            "local",
            "internal",
            "home.arpa",
            "lan",
            "127.0.0.1",
            "[::1]",
        ] {
            assert!(blocked_hostname(h), "{h}");
        }
        for h in ["relay.nostu.be", "relay.example.com", "8.8.8.8", ""] {
            assert!(!blocked_hostname(h), "{h}");
        }
        let list = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(
            sanitize_with_policy(
                &list(&[
                    "ws://127.0.0.1:7700/probe",
                    "http://169.254.169.254/latest/meta-data",
                    "https://[::1]/",
                    "wss://foo.internal/",
                    "wss://user:pw@relay.example/",
                    "relay.example.com"
                ]),
                false,
                false,
                4
            )
            .is_empty()
        );
        assert_eq!(
            sanitize_with_policy(
                &list(&[
                    "wss://relay.example.com//x///?b=2&a=1#frag",
                    "wss://relay.example.com/x?a=1&b=2",
                    "wss://relay.example.com/"
                ]),
                false,
                false,
                4
            ),
            list(&[
                "wss://relay.example.com/x?a=1&b=2",
                "wss://relay.example.com/"
            ])
        );
        assert_eq!(
            sanitize_with_policy(
                &list(&[
                    "http://relay.example.com",
                    "ws://127.0.0.1:7700/probe",
                    "wss://10.0.0.5/",
                    "wss://foo.internal/"
                ]),
                true,
                true,
                2
            ),
            list(&["ws://relay.example.com/", "ws://127.0.0.1:7700/probe"])
        );
        let many = (0..100)
            .map(|i| format!("wss://relay-{i}.example.com"))
            .collect::<Vec<_>>();
        assert_eq!(sanitize_with_policy(&many, false, false, 4).len(), 4);
        assert!(
            sanitize_with_policy(
                &[format!("wss://relay.example.com/{}", "x".repeat(600))],
                false,
                false,
                4
            )
            .is_empty()
        );
    }
}

use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr};
use url::Url;

fn private_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    a == 0
        || a == 10
        || (a == 100 && (64..=127).contains(&b))
        || a == 127
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && ((b == 0 && (c == 0 || c == 2)) || b == 168))
        || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
        || (a == 203 && b == 0 && c == 113)
        || a >= 224
}
fn private_address(address: &str) -> bool {
    let s = address
        .trim()
        .trim_start_matches('[')
        .split(']')
        .next()
        .unwrap_or("");
    match s.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => private_v4(ip),
        Ok(IpAddr::V6(ip)) => {
            let h = ip.segments();
            if h[..5] == [0, 0, 0, 0, 0] && (h[5] == 0xffff || h[5] == 0 && (h[6] != 0 || h[7] > 1))
                || h[..6] == [0x64, 0xff9b, 0, 0, 0, 0]
            {
                return private_v4(Ipv4Addr::new(
                    (h[6] >> 8) as u8,
                    h[6] as u8,
                    (h[7] >> 8) as u8,
                    h[7] as u8,
                ));
            }
            ip.is_unspecified()
                || ip.is_loopback()
                || h[0] & 0xfe00 == 0xfc00
                || h[0] & 0xffc0 == 0xfe80
                || h[0] & 0xff00 == 0xff00
                || (h[0] == 0x2001 && h[1] == 0xdb8)
        }
        Err(_) => false,
    }
}
fn blocked_hostname(host: &str) -> bool {
    let h = host.trim().to_lowercase();
    let h = h.strip_suffix('.').unwrap_or(&h);
    ["localhost", "local", "internal", "home.arpa", "lan"].contains(&h)
        || [".localhost", ".local", ".internal", ".home.arpa", ".lan"]
            .iter()
            .any(|s| h.ends_with(s))
        || private_address(h)
}
pub fn sanitize_relay_hints(relays: &[String]) -> Vec<String> {
    let allow_private = crate::util::env_bool("RELAY_HINT_ALLOW_PRIVATE");
    let allow_insecure = crate::util::env_bool("RELAY_HINT_ALLOW_INSECURE");
    let max = crate::util::env_u64("RELAY_HINT_MAX", 4) as usize;
    sanitize_with_policy(relays, allow_private, allow_insecure, max)
}
fn sanitize_with_policy(
    relays: &[String],
    allow_private: bool,
    allow_insecure: bool,
    max: usize,
) -> Vec<String> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for raw in relays {
        if raw.is_empty() || raw.encode_utf16().count() > 512 {
            continue;
        }
        let Ok(mut u) = Url::parse(raw) else { continue };
        match u.scheme() {
            "https" => {
                let _ = u.set_scheme("wss");
            }
            "http" => {
                let _ = u.set_scheme("ws");
            }
            _ => {}
        }
        if u.scheme() != "wss" && !(allow_insecure && u.scheme() == "ws") {
            continue;
        }
        if !u.username().is_empty() || u.password().is_some() {
            continue;
        }
        let Some(host) = u.host_str() else { continue };
        if !allow_private && blocked_hostname(host) {
            continue;
        }
        let path = u
            .path()
            .split('/')
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>()
            .join("/");
        u.set_path(&format!("/{path}"));
        u.set_fragment(None);
        if u.query().is_some() {
            let mut pairs: Vec<(String, String)> = u
                .query_pairs()
                .map(|(a, b)| (a.into_owned(), b.into_owned()))
                .collect();
            pairs.sort_by(|a, b| a.0.cmp(&b.0));
            u.set_query(None);
            u.query_pairs_mut().extend_pairs(pairs);
        }
        let key = u.to_string();
        if seen.insert(key.clone()) {
            result.push(key);
            if result.len() >= max {
                break;
            }
        }
    }
    result
}
pub async fn resolve_safe_relay_hints(relays: &[String]) -> Vec<String> {
    let relays = sanitize_relay_hints(relays);
    if crate::util::env_bool("RELAY_HINT_ALLOW_PRIVATE") {
        return relays;
    }
    let timeout =
        std::time::Duration::from_millis(crate::util::env_u64("RELAY_HINT_DNS_TIMEOUT_MS", 2000));
    let checks = relays.iter().map(|relay| async move {
        let Ok(url) = Url::parse(relay) else {
            return false;
        };
        let Some(host) = url.host_str() else {
            return false;
        };
        let host = host.trim_start_matches('[').trim_end_matches(']');
        if host.parse::<IpAddr>().is_ok() {
            return true;
        }
        match tokio::time::timeout(
            timeout,
            tokio::net::lookup_host((host, url.port_or_known_default().unwrap_or(443))),
        )
        .await
        {
            Ok(Ok(addrs)) => {
                let addrs: Vec<_> = addrs.collect();
                !addrs.is_empty() && addrs.iter().all(|a| !private_address(&a.ip().to_string()))
            }
            _ => false,
        }
    });
    let keep = futures_util::future::join_all(checks).await;
    relays
        .into_iter()
        .zip(keep)
        .filter_map(|(r, keep)| keep.then_some(r))
        .collect()
}
