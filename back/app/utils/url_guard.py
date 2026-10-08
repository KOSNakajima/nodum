"""Guard against server-side request forgery on user-supplied URLs.

The AI provider `base_url` is a user-controlled address the *server* then makes
authenticated POSTs to. Unvalidated, any signed-up user can aim it at the cloud
metadata endpoint (169.254.169.254), at compose-network hostnames like
``postgres``/``redis``/``minio``, or at an admin port on localhost — and the
provider error mapping is descriptive enough to fingerprint what answered.

Self-hosting is a legitimate use of the field (``http://ollama:11434/v1`` on a
private address is the canonical case), so private destinations are refused by
default but can be re-enabled with AI_ALLOW_PRIVATE_BASE_URLS rather than
silently removed.
"""

import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit

_ALLOWED_SCHEMES = ("http", "https")


class UnsafeUrlError(ValueError):
    """The URL is syntactically bad or resolves somewhere it must not."""


def _is_forbidden(ip: str) -> bool:
    try:
        address = ipaddress.ip_address(ip)
    except ValueError:
        # Not parseable as an address — treat as unsafe rather than guess.
        return True
    return (
        address.is_private
        or address.is_loopback
        or address.is_link_local  # 169.254.0.0/16 — cloud metadata lives here
        or address.is_reserved
        or address.is_multicast
        or address.is_unspecified
    )


async def assert_safe_url(url: str, *, allow_private: bool) -> None:
    """Raise UnsafeUrlError unless `url` is a plain HTTP(S) URL we may call.

    Resolution goes through the event loop's resolver, not a bare
    ``socket.getaddrinfo``: this runs on the async request path, and blocking
    DNS there would stall every other request on the worker.

    Called at save time *and* immediately before each provider request. Save
    time alone is not enough — it misses credentials stored before this guard
    existed, and it is defeated by a name that resolves differently on the
    second lookup.
    """
    parts = urlsplit(url)
    if parts.scheme.lower() not in _ALLOWED_SCHEMES:
        raise UnsafeUrlError("Endpoint must start with http:// or https://.")
    if parts.username or parts.password:
        raise UnsafeUrlError("Endpoint must not embed credentials.")
    if parts.fragment:
        raise UnsafeUrlError("Endpoint must not contain a fragment.")

    host = parts.hostname
    if not host:
        raise UnsafeUrlError("Endpoint is missing a host.")

    if allow_private:
        return

    addresses = await _resolve(host, parts.port or (443 if parts.scheme == "https" else 80))
    # Every answer must be acceptable: one public A record alongside a private
    # one would otherwise be enough to get through.
    if any(_is_forbidden(address) for address in addresses):
        raise UnsafeUrlError(
            "Endpoint resolves to a private or reserved address. "
            "Set AI_ALLOW_PRIVATE_BASE_URLS=true to allow self-hosted endpoints."
        )


async def _resolve(host: str, port: int) -> list[str]:
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except OSError as exc:
        raise UnsafeUrlError("Host could not be resolved.") from exc
    return [str(info[4][0]) for info in infos]


async def resolve_public_address(host: str, port: int) -> str:
    """Resolve `host` once and return the public address to connect to.

    For fetching pages the AI asked for, checking a name and then letting the
    HTTP client resolve it again is not enough: a DNS answer with a zero TTL
    can be public for the check and 127.0.0.1 for the connection. The caller
    connects to the address returned here instead, so what was checked is what
    gets dialled. Every answer must be public, as in `assert_safe_url`.
    """
    addresses = await _resolve(host, port)
    if not addresses or any(_is_forbidden(address) for address in addresses):
        raise UnsafeUrlError("That address is on a private or reserved network.")
    return addresses[0]
