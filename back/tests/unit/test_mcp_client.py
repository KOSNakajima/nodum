"""Nodum as an MCP client: talking to a server (in-process here), naming its
tools for the model, and turning results into transcript steps."""

from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from mcp.client import Client
from mcp.server.mcpserver import MCPServer

from app.services import mcp_client

TAVILY_STYLE = (
    "Detailed Results:\n\n"
    "Title: Logseq: A privacy-first knowledge base\nURL: https://logseq.com/\nContent: Outliner.\n\n"
    "Title: AppFlowy\nURL: https://github.com/AppFlowy-IO/AppFlowy\nContent: Open source."
)


def _server() -> MCPServer:
    server = MCPServer("stub")

    @server.tool()
    def web_search(query: str) -> str:
        """Search the web."""
        return TAVILY_STYLE

    @server.tool()
    def huge() -> str:
        return "x" * (mcp_client.MAX_RESULT_CHARS + 50)

    @server.tool()
    def broken() -> str:
        raise ValueError("internal detail")

    return server


@pytest.fixture
def in_process(monkeypatch: pytest.MonkeyPatch) -> None:
    server = _server()

    @asynccontextmanager
    async def connect(url, token):
        async with Client(server) as client:
            yield client

    monkeypatch.setattr(mcp_client, "connect", connect)


async def test_list_tools_reads_names_descriptions_and_schemas(in_process) -> None:
    tools = {t["name"]: t for t in await mcp_client.list_tools("https://mcp.example/", None)}
    assert set(tools) == {"web_search", "huge", "broken"}
    assert tools["web_search"]["description"] == "Search the web."
    schema = tools["web_search"]["input_schema"]
    assert schema["type"] == "object" and "query" in schema["properties"]


async def test_call_tool_returns_text_and_caps_it(in_process) -> None:
    found = await mcp_client.call_tool("https://mcp.example/", None, "web_search", {"query": "q"})
    assert found == {"ok": True, "content": TAVILY_STYLE, "truncated": False}
    big = await mcp_client.call_tool("https://mcp.example/", None, "huge", {})
    assert big["truncated"] and len(big["content"]) == mcp_client.MAX_RESULT_CHARS


async def test_a_failing_tool_is_an_error_result_not_an_exception(in_process) -> None:
    result = await mcp_client.call_tool("https://mcp.example/", None, "broken", {})
    assert result["ok"] is False
    assert "internal detail" not in result["error"]


async def test_a_private_address_is_refused_before_connecting(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mcp_client, "get_settings", lambda: SimpleNamespace(AI_ALLOW_PRIVATE_BASE_URLS=False))
    with pytest.raises(mcp_client.MCPClientError, match="private"):
        await mcp_client.list_tools("http://127.0.0.1:8080/mcp", None)
    result = await mcp_client.call_tool("http://169.254.169.254/mcp", "tok", "x", {})
    assert result["ok"] is False and "private" in result["error"]


def test_chat_tool_names_are_prefixed_and_provider_safe() -> None:
    assert mcp_client.chat_tool_name(1, "tavily_search") == "mcp1_tavily_search"
    assert mcp_client.chat_tool_name(2, "files.read/all") == "mcp2_files_read_all"
    assert len(mcp_client.chat_tool_name(3, "x" * 100)) == 64


def test_schema_is_always_an_object() -> None:
    assert mcp_client._schema({"$schema": "http://json-schema.org/draft-07/schema#", "type": "object"}) == {
        "type": "object",
        "properties": {},
    }
    assert mcp_client._schema(None) == {"type": "object", "properties": {}}


def test_links_reads_title_and_url_lines_then_falls_back_to_bare_urls() -> None:
    assert mcp_client.links(TAVILY_STYLE) == [
        {"title": "Logseq: A privacy-first knowledge base", "url": "https://logseq.com/"},
        {"title": "AppFlowy", "url": "https://github.com/AppFlowy-IO/AppFlowy"},
    ]
    assert mcp_client.links("see https://a.example/x and (https://b.example/y).") == [
        {"title": "", "url": "https://a.example/x"},
        {"title": "", "url": "https://b.example/y"},
    ]


def test_describe_names_the_server_tool_and_what_came_back() -> None:
    step = mcp_client.describe(
        "Tavily", "tavily_search", {"query": "obsidian alternatives"}, {"ok": True, "content": TAVILY_STYLE}
    )
    assert step["kind"] == "mcp" and step["server"] == "Tavily" and step["tool"] == "tavily_search"
    assert step["detail"] == "obsidian alternatives" and step["count"] == 2
    failed = mcp_client.describe("Tavily", "tavily_search", {"query": "q"}, {"ok": False, "error": "boom"})
    assert failed == {"kind": "failed", "tool": "Tavily · tavily_search", "detail": "q", "error": "boom"}


def test_http_failures_read_as_a_status_never_a_body() -> None:
    assert str(mcp_client._status_error(401)) == "The server refused the token (401)."
    assert str(mcp_client._status_error(405)) == "No MCP server answers at that URL (405)."
    assert str(mcp_client._status_error(502)) == "The server answered with an error (502)."


def test_the_step_shows_the_query_not_whichever_string_came_first() -> None:
    args = {"topic": "general", "query": "Jev overview", "search_depth": "basic"}
    assert mcp_client._detail(args) == "Jev overview"
    assert mcp_client._detail({"urls": ["https://a.example/", "https://b.example/"]}) == (
        "https://a.example/, https://b.example/"
    )
    assert mcp_client._detail({"topic": "news"}) == "news"


def test_links_reads_a_json_result_with_titles() -> None:
    text = (
        '{"query": "jev", "answer": null, "results": ['
        '{"url": "https://typesafe.ai/blog/series-ai", "title": "Series A", "content": "..."},'
        '{"url": "https://console.typesafe.ai", "title": "Console", "content": "..."}]}'
    )
    assert mcp_client.links(text) == [
        {"title": "Series A", "url": "https://typesafe.ai/blog/series-ai"},
        {"title": "Console", "url": "https://console.typesafe.ai"},
    ]
