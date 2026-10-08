"""Fetch one web page for the assistant's `fetch_url` tool.

The URL comes from a model, and a model can be talked into anything by the
text it reads — so this is a server-side request to an address an attacker
may have chosen. What keeps it from becoming a way into the compose network:

- every hop is resolved once, refused if ANY answer is private or reserved,
  and then dialled by that address (TLS still verifies the real hostname via
  SNI), so a rebinding DNS answer cannot swap in 127.0.0.1 between check and
  connect;
- redirects are followed by hand, and each Location gets the same check;
- the environment's proxy settings are ignored, since a proxy would do its own
  resolution and undo the pinning;
- the body is capped in bytes and the result in characters, and only text
  content types are read at all.

What comes back is the page as markdown — the same converter the importers
use, so scripts, styles and inline handlers never reach the model.
"""

import codecs
import html
import re
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx

from app.services.importers.html_md import html_to_markdown
from app.utils.url_guard import UnsafeUrlError, resolve_public_address

MAX_BYTES = 2 * 1024 * 1024
MAX_CHARS = 12_000
MAX_REDIRECTS = 5
_TIMEOUT = httpx.Timeout(15.0, connect=5.0)
_USER_AGENT = "Mozilla/5.0 (compatible; Nodum/1.0; +https://nodum.md)"
_REDIRECTS = (301, 302, 303, 307, 308)
_HTML_TYPES = ("text/html", "application/xhtml+xml")
_TEXT_TYPES = ("text/plain", "text/markdown")

_TITLE = re.compile(r"<title\b[^>]*>(.*?)</title\s*>", re.IGNORECASE | re.DOTALL)
_META_CHARSET = re.compile(rb"""<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_\-]+)""", re.IGNORECASE)
_MAIN = re.compile(r"<(article|main)\b[^>]*>(.*?)</\1\s*>", re.IGNORECASE | re.DOTALL)
#: Not content: <head> (its <title> is returned separately), then site chrome
#: — menus, banners, sidebars, sign-up forms. Images only cost tokens; the
#: model cannot see them.
_CHROME = ("head", "nav", "header", "footer", "aside", "form")
_IMG = re.compile(r"<img\b[^>]*>", re.IGNORECASE)
#: XHTML pages open with an XML declaration that would otherwise surface as
#: the first line of the "content".
_PROLOG = re.compile(r"<\?xml[^>]*\?>|<!DOCTYPE[^>]*>", re.IGNORECASE)
_TAGS = re.compile(r"<[^>]+>")
_HREF = re.compile(r"""(\bhref\s*=\s*)(["'])(.*?)\2""", re.IGNORECASE | re.DOTALL)


class FetchError(Exception):
    """The page could not be read. The message is safe to hand to the model."""


@dataclass(frozen=True)
class Page:
    url: str
    title: str
    content: str
    truncated: bool


async def fetch_page(url: str) -> Page:
    """GET `url`, following up to MAX_REDIRECTS checked redirects."""
    current = (url or "").strip()
    for _ in range(MAX_REDIRECTS + 1):
        status, headers, body, cut = await _get(current)
        if status in _REDIRECTS:
            location = headers.get("location")
            if not location:
                raise FetchError(f"The page redirected (HTTP {status}) without saying where.")
            current = urljoin(current, location)
            continue
        if status >= 400:
            raise FetchError(f"The page answered HTTP {status}.")
        return _to_page(current, headers.get("content-type", ""), body, cut)
    raise FetchError("The page redirected too many times.")


async def _get(url: str) -> tuple[int, httpx.Headers, bytes, bool]:
    """One request, to a vetted address. Returns the body only for a final
    answer — a redirect's body is never read."""
    parts = urlsplit(url)
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https"):
        raise FetchError("Only http:// and https:// URLs can be opened.")
    if parts.username or parts.password:
        raise FetchError("URLs with embedded credentials are not opened.")
    if not parts.hostname:
        raise FetchError("That URL has no host.")
    try:
        # Host and SNI must be ASCII; an internationalised name goes as punycode.
        host = parts.hostname.encode("idna").decode("ascii")
        port = parts.port or (443 if scheme == "https" else 80)
    except (UnicodeError, ValueError) as exc:
        raise FetchError("That URL's host or port is not valid.") from exc
    netloc = f"[{host}]" if ":" in host else host
    if parts.port is not None:
        netloc = f"{netloc}:{parts.port}"
    try:
        address = await resolve_public_address(host, port)
    except UnsafeUrlError as exc:
        raise FetchError(str(exc)) from exc

    literal = f"[{address}]" if ":" in address else address
    target = urlunsplit((scheme, f"{literal}:{port}", parts.path or "/", parts.query, ""))
    headers = {"Host": netloc, "User-Agent": _USER_AGENT, "Accept": "text/html,text/plain;q=0.9,*/*;q=0.1"}
    extensions = {"sni_hostname": host} if scheme == "https" else {}

    try:
        async with (
            httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=False, trust_env=False) as client,
            client.stream("GET", target, headers=headers, extensions=extensions) as response,
        ):
            if response.status_code in _REDIRECTS or response.status_code >= 400:
                return response.status_code, response.headers, b"", False
            kind = response.headers.get("content-type", "").split(";")[0].strip().lower()
            if kind and kind not in _HTML_TYPES + _TEXT_TYPES:
                raise FetchError(f"That is not a web page ({kind}).")
            chunks: list[bytes] = []
            size = 0
            cut = False
            async for chunk in response.aiter_bytes():
                chunks.append(chunk)
                size += len(chunk)
                if size >= MAX_BYTES:
                    cut = True
                    break
            return response.status_code, response.headers, b"".join(chunks)[:MAX_BYTES], cut
    except httpx.TimeoutException as exc:
        raise FetchError("The page took too long to answer.") from exc
    except httpx.HTTPError as exc:
        raise FetchError("The page could not be reached.") from exc


def _decode(body: bytes, content_type: str) -> str:
    """Header charset, else <meta charset>, else UTF-8 — Japanese pages still
    often declare Shift_JIS or EUC-JP in a meta tag only."""
    declared = re.search(r"charset=([\w\-]+)", content_type, re.IGNORECASE)
    meta = _META_CHARSET.search(body[:4096])
    encoding = (declared.group(1) if declared else None) or (meta.group(1).decode() if meta else None) or "utf-8"
    try:
        codecs.lookup(encoding)
    except LookupError:
        encoding = "utf-8"
    return body.decode(encoding, errors="replace")


def _absolute_links(document: str, base: str) -> str:
    """Rewrite relative hrefs against the page URL. The assistant may only open
    links that appear verbatim in what it has read (see ai_tools), so a
    relative link it would have to resolve itself could never be followed."""

    def absolute(match: re.Match[str]) -> str:
        target = urljoin(base, html.unescape(match.group(3)).strip())
        return f"{match.group(1)}{match.group(2)}{html.escape(target, quote=True)}{match.group(2)}"

    return _HREF.sub(absolute, document)


def _main_html(document: str) -> str:
    """The page's own content when it marks it (<article>/<main>), else the
    whole document — minus the site chrome either way."""
    for tag in _CHROME:
        document = re.sub(rf"<{tag}\b[^>]*>.*?</{tag}\s*>", " ", document, flags=re.IGNORECASE | re.DOTALL)
    document = _PROLOG.sub(" ", _IMG.sub(" ", document))
    marked = _MAIN.search(document)
    # A <main> that is only a wrapper around a widget is not the content.
    if marked and len(_TAGS.sub("", marked.group(2)).strip()) >= 200:
        return marked.group(2)
    return document


def _to_page(url: str, content_type: str, body: bytes, cut: bool) -> Page:
    text = _decode(body, content_type)
    kind = content_type.split(";")[0].strip().lower()
    if kind in _TEXT_TYPES:
        title, content = "", text.strip()
    else:
        found = _TITLE.search(text)
        title = re.sub(r"\s+", " ", html.unescape(found.group(1))).strip() if found else ""
        content = html_to_markdown(_main_html(_absolute_links(text, url)))
    if not content:
        raise FetchError("The page has no readable text (it may need JavaScript to render).")
    truncated = cut or len(content) > MAX_CHARS
    return Page(url=url, title=title, content=content[:MAX_CHARS], truncated=truncated)
