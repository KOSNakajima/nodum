"""`web_fetch.fetch_page` — the assistant's page reader. No network: DNS and
HTTP are both stubbed, so what is asserted is what would be dialled."""

import httpx
import pytest

from app.services import ai_tools, web_fetch
from app.utils import url_guard
from app.utils.url_guard import UnsafeUrlError

PUBLIC = {"example.com": "93.184.216.34", "other.example": "93.184.216.35"}


@pytest.fixture
def dns(monkeypatch: pytest.MonkeyPatch) -> None:
    async def resolve(host: str, port: int) -> str:
        if host in PUBLIC:
            return PUBLIC[host]
        raise UnsafeUrlError("That address is on a private or reserved network.")

    monkeypatch.setattr(web_fetch, "resolve_public_address", resolve)


def _serve(monkeypatch: pytest.MonkeyPatch, handler) -> list[httpx.Request]:
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    real = httpx.AsyncClient
    monkeypatch.setattr(web_fetch.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(record), **kw))
    return seen


def _html(body: str, **headers: str) -> httpx.Response:
    return httpx.Response(200, content=body.encode(), headers={"content-type": "text/html; charset=utf-8", **headers})


async def test_page_becomes_markdown_and_is_dialled_by_vetted_address(
    dns: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    page = (
        "<html><head><title> Hello &amp; welcome </title><script>steal()</script></head><body>"
        "<nav>Home | About</nav><main><h1>Heading</h1><p>"
        + "Real content. " * 20
        + "</p></main><footer>© footer</footer></body></html>"
    )
    seen = _serve(monkeypatch, lambda _: _html(page))

    result = await web_fetch.fetch_page("https://example.com/post?id=1")

    assert result.title == "Hello & welcome"
    assert result.content.startswith("# Heading")
    assert "steal" not in result.content
    assert "Home | About" not in result.content and "footer" not in result.content
    assert result.truncated is False
    # Connected to the address that was checked, with the real name for Host and TLS.
    request = seen[0]
    assert request.url.host == "93.184.216.34"
    assert request.url.path == "/post" and request.url.query == b"id=1"
    assert request.headers["host"] == "example.com"
    assert request.extensions["sni_hostname"] == "example.com"


async def test_redirect_into_a_private_network_is_refused(dns: None, monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _serve(monkeypatch, lambda _: httpx.Response(302, headers={"location": "http://internal.test/admin"}))
    with pytest.raises(web_fetch.FetchError, match="private or reserved"):
        await web_fetch.fetch_page("https://example.com/")
    assert len(seen) == 1  # the private hop was never requested


async def test_redirect_is_followed_and_reported_url_is_final(dns: None, monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.headers["host"] == "example.com":
            return httpx.Response(301, headers={"location": "https://other.example/final"})
        return _html("<p>" + "Moved here. " * 30 + "</p>")

    _serve(monkeypatch, handler)
    result = await web_fetch.fetch_page("https://example.com/start")
    assert result.url == "https://other.example/final"
    assert "Moved here." in result.content


async def test_redirect_loop_gives_up(dns: None, monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _serve(monkeypatch, lambda _: httpx.Response(302, headers={"location": "/again"}))
    with pytest.raises(web_fetch.FetchError, match="too many"):
        await web_fetch.fetch_page("https://example.com/")
    assert len(seen) == web_fetch.MAX_REDIRECTS + 1


@pytest.mark.parametrize("url", ["file:///etc/passwd", "ftp://example.com/x", "https://user:pw@example.com/", ""])
async def test_unsupported_urls_never_touch_the_network(dns: None, monkeypatch: pytest.MonkeyPatch, url: str) -> None:
    seen = _serve(monkeypatch, lambda _: _html("<p>x</p>"))
    with pytest.raises(web_fetch.FetchError):
        await web_fetch.fetch_page(url)
    assert seen == []


async def test_non_text_content_is_not_read(dns: None, monkeypatch: pytest.MonkeyPatch) -> None:
    _serve(monkeypatch, lambda _: httpx.Response(200, content=b"\x89PNG", headers={"content-type": "image/png"}))
    with pytest.raises(web_fetch.FetchError, match="image/png"):
        await web_fetch.fetch_page("https://example.com/logo.png")


async def test_body_is_capped(dns: None, monkeypatch: pytest.MonkeyPatch) -> None:
    huge = "<p>" + "word " * (web_fetch.MAX_BYTES // 4) + "</p>"
    _serve(monkeypatch, lambda _: _html(huge))
    result = await web_fetch.fetch_page("https://example.com/")
    assert result.truncated is True
    assert len(result.content) <= web_fetch.MAX_CHARS


async def test_meta_charset_decodes_shift_jis(dns: None, monkeypatch: pytest.MonkeyPatch) -> None:
    body = '<?xml version="1.0" encoding="Shift_JIS"?><html><head><meta charset="Shift_JIS"><title>こころ</title>'
    body += "</head><body><p>私はその人を常に先生と呼んでいた。</p></body></html>"
    _serve(
        monkeypatch,
        lambda _: httpx.Response(200, content=body.encode("shift_jis"), headers={"content-type": "text/html"}),
    )
    result = await web_fetch.fetch_page("https://example.com/kokoro.html")
    assert result.title == "こころ"
    assert result.content == "私はその人を常に先生と呼んでいた。"


async def test_http_error_status_is_reported(dns: None, monkeypatch: pytest.MonkeyPatch) -> None:
    _serve(monkeypatch, lambda _: httpx.Response(404))
    with pytest.raises(web_fetch.FetchError, match="404"):
        await web_fetch.fetch_page("https://example.com/missing")


async def test_any_private_answer_refuses_the_name(monkeypatch: pytest.MonkeyPatch) -> None:
    async def answers(host: str, port: int) -> list[str]:
        return ["93.184.216.34", "10.0.0.5"]

    monkeypatch.setattr(url_guard, "_resolve", answers)
    with pytest.raises(UnsafeUrlError):
        await url_guard.resolve_public_address("mixed.example", 443)


async def test_fetch_url_tool_reports_failure_and_records_visits(monkeypatch: pytest.MonkeyPatch) -> None:
    async def refuse(url: str) -> web_fetch.Page:
        raise web_fetch.FetchError("The page answered HTTP 404.")

    monkeypatch.setattr(web_fetch, "fetch_page", refuse)
    result = await ai_tools.run_tool(None, None, None, "fetch_url", {"url": "https://example.com/x"})  # type: ignore[arg-type]
    assert result == {"ok": False, "error": "The page answered HTTP 404."}
    assert ai_tools.describe("fetch_url", {}, result) is None

    visited = {"ok": True, "url": "https://example.com/x", "title": "", "content": "…", "truncated": False}
    assert ai_tools.describe("fetch_url", {}, visited) == {
        "kind": "visited",
        "title": "https://example.com/x",
        "url": "https://example.com/x",
    }


async def test_relative_links_become_absolute(dns: None, monkeypatch: pytest.MonkeyPatch) -> None:
    page = '<p><a href="/docs?a=1&amp;b=2">Docs</a> and <a href="next.html">next</a> ' + "text " * 50 + "</p>"
    _serve(monkeypatch, lambda _: _html(page))
    result = await web_fetch.fetch_page("https://example.com/guide/intro.html")
    assert "(https://example.com/docs?a=1&b=2)" in result.content
    assert "(https://example.com/guide/next.html)" in result.content


@pytest.mark.parametrize(
    ("url", "grounded"),
    [
        ("https://example.com/post", True),  # verbatim
        ("https://example.com/post/", True),  # trailing slash added by the model
        ("https://ja.wikipedia.org/wiki/%E6%9D%B1%E4%BA%AC", True),  # encoded form of a pasted URL
        ("https://example.com/linked", True),  # appeared in a tool result
        ("https://attacker.example/?d=secret-note-text", False),  # built by the model
        ("https://", False),
        ("", False),
    ],
)
def test_fetch_url_only_opens_links_it_was_given(url: str, grounded: bool) -> None:
    sources = [
        "このページを要約して https://example.com/post と https://ja.wikipedia.org/wiki/東京",
        '{"ok": true, "content": "see [here](https://example.com/linked) — secret-note-text"}',
    ]
    assert ai_tools.url_is_grounded(url, sources) is grounded
