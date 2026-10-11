"""Calling remote MCP servers on the chat's behalf — Nodum as an MCP client.

A registered server (`MCPServer`) is reached over Streamable HTTP from the API
process, never from the browser, so its token stays on the server. Every
connection re-checks the URL against private networks first (`assert_safe_url`,
the same policy as a custom AI endpoint), follows no redirects and ignores
proxy environment variables, so a URL that passed the check is the one dialled.

What comes back is untrusted: tool descriptions are trimmed, results are capped
and handed to the model as data, and errors are reduced to a sentence that
does not echo the server's body.

Connections are short-lived — one per listing or call. A turn makes a handful
of calls at most, and holding sessions open across requests would tie a
worker's connection to a server it may not need again.
"""

import json
import logging
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from typing import Any

import httpx2
from mcp.client import Client
from mcp.client.streamable_http import streamable_http_client

from app.settings import get_settings
from app.utils.url_guard import UnsafeUrlError, assert_safe_url

logger = logging.getLogger(__name__)

CONNECT_TIMEOUT = 10.0
CALL_TIMEOUT = 45.0
#: Tools kept from one server. A server offering more is unusual, and every
#: declaration costs prompt tokens on every round.
MAX_TOOLS = 40
MAX_DESCRIPTION_CHARS = 1_000
#: A tool result handed to the model — the same budget as a fetched page.
MAX_RESULT_CHARS = 12_000
#: Links listed under a step in the transcript.
MAX_LINKS = 10


class MCPClientError(Exception):
    """A sentence for the user (and the model) about what went wrong."""


def _leaf(exc: BaseException) -> BaseException:
    """The first real error inside the task-group wrappers the SDK raises."""
    while isinstance(exc, BaseExceptionGroup) and exc.exceptions:
        exc = exc.exceptions[0]
    return exc


def _status_error(status: int) -> MCPClientError:
    if status in (401, 403):
        return MCPClientError(f"The server refused the token ({status}).")
    if status in (404, 405):
        return MCPClientError(f"No MCP server answers at that URL ({status}).")
    return MCPClientError(f"The server answered with an error ({status}).")


def _client_error(exc: BaseException) -> MCPClientError:
    """Reduce a transport or protocol failure to a status, never the body."""
    exc = _leaf(exc)
    if isinstance(exc, MCPClientError):
        return exc
    if isinstance(exc, httpx2.HTTPStatusError):
        return _status_error(exc.response.status_code)
    if isinstance(exc, httpx2.TimeoutException | TimeoutError):
        return MCPClientError("The server did not answer in time.")
    if isinstance(exc, httpx2.TransportError):
        return MCPClientError("Could not reach the server.")
    logger.info("mcp client failure: %s", type(exc).__name__)
    return MCPClientError("The server did not speak MCP as expected.")


@asynccontextmanager
async def connect(url: str, token: str | None) -> AsyncIterator[Client]:
    """An initialised MCP session with the server at `url`.

    Tests replace this with an in-process server; everything else goes
    through it, so the URL check cannot be skipped.
    """
    try:
        await assert_safe_url(url, allow_private=get_settings().AI_ALLOW_PRIVATE_BASE_URLS)
    except UnsafeUrlError as exc:
        raise MCPClientError(str(exc)) from exc
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    # The SDK turns an HTTP error into a bare "error response"; keep the
    # status so a rejected token reads as one.
    refused: list[int] = []

    async def note_status(response: httpx2.Response) -> None:
        if response.status_code >= 400:
            refused.append(response.status_code)

    http = httpx2.AsyncClient(
        headers=headers,
        follow_redirects=False,
        trust_env=False,
        timeout=httpx2.Timeout(CALL_TIMEOUT, connect=CONNECT_TIMEOUT),
        event_hooks={"response": [note_status]},
    )
    try:
        async with (
            http,
            Client(streamable_http_client(url, http_client=http), read_timeout_seconds=CALL_TIMEOUT) as c,
        ):
            yield c
    except Exception as exc:
        if refused:
            raise _status_error(refused[-1]) from exc
        raise


def _schema(raw: Any) -> dict[str, Any]:
    """A tool's input schema as a function-calling `parameters` object."""
    schema = dict(raw) if isinstance(raw, dict) else {}
    schema.pop("$schema", None)
    if schema.get("type") != "object":
        schema = {"type": "object", "properties": {}}
    schema.setdefault("properties", {})
    return schema


async def list_tools(url: str, token: str | None) -> list[dict[str, Any]]:
    """The server's tools: [{name, description, input_schema}]."""
    tools: list[dict[str, Any]] = []
    try:
        async with connect(url, token) as client:
            cursor: str | None = None
            while len(tools) < MAX_TOOLS:
                page = await client.list_tools(cursor=cursor)
                for tool in page.tools:
                    tools.append(
                        {
                            "name": tool.name,
                            "description": (tool.description or tool.title or "")[:MAX_DESCRIPTION_CHARS],
                            "input_schema": _schema(tool.input_schema),
                        }
                    )
                cursor = page.next_cursor
                if not cursor:
                    break
    except Exception as exc:
        raise _client_error(exc) from exc
    return tools[:MAX_TOOLS]


def _text(result: Any) -> str:
    """A tool result's content as text: text parts as-is, others named."""
    parts: list[str] = []
    for item in result.content or []:
        kind = getattr(item, "type", "")
        if kind == "text":
            parts.append(item.text)
        else:
            parts.append(f"[{kind or 'content'} omitted]")
    if not parts and result.structured_content is not None:
        parts.append(json.dumps(result.structured_content, ensure_ascii=False))
    return "\n".join(parts)


async def call_tool(url: str, token: str | None, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Run one tool. Returns the shape every chat tool returns: `ok` plus
    `content` (capped, with `truncated`) or `error`. Never raises."""
    try:
        async with connect(url, token) as client:
            result = await client.call_tool(name, arguments)
    except Exception as exc:
        return {"ok": False, "error": str(_client_error(exc))}
    text = _text(result)
    if result.is_error:
        return {"ok": False, "error": (text or "The tool failed.")[:500]}
    return {"ok": True, "content": text[:MAX_RESULT_CHARS], "truncated": len(text) > MAX_RESULT_CHARS}


# ── In the chat ─────────────────────────────────────────────────────

_NAME_UNSAFE = re.compile(r"[^A-Za-z0-9_-]")


def chat_tool_name(index: int, tool: str) -> str:
    """The name the model sees for a server's tool: `mcp<index>_<tool>`.

    Prefixed so it can never shadow a vault tool or another server's tool of
    the same name, and cleaned to what every provider accepts (letters,
    digits, `_`, `-`; at most 64).
    """
    return f"mcp{index}_{_NAME_UNSAFE.sub('_', tool)}"[:64]


_TITLE_LINE = re.compile(r"^\s*Title:\s*(.+?)\s*$")
_URL_LINE = re.compile(r"^\s*URL:\s*(https?://\S+)\s*$")
_ANY_URL = re.compile(r"https?://[^\s<>\"')\]]+")


def _json_links(value: Any, found: list[dict[str, str]], seen: set[str]) -> None:
    """Every object with an http(s) `url` in a JSON result, with its `title`."""
    if isinstance(value, dict):
        url = value.get("url")
        if isinstance(url, str) and url.startswith(("http://", "https://")) and url not in seen:
            seen.add(url)
            title = value.get("title")
            found.append({"title": title.strip() if isinstance(title, str) else "", "url": url})
        for child in value.values():
            _json_links(child, found, seen)
    elif isinstance(value, list):
        for child in value:
            _json_links(child, found, seen)


def links(text: str) -> list[dict[str, str]]:
    """The links in a tool result, titled where the result says so.

    Search servers answer either in JSON (`{"results": [{"title", "url"}]}`,
    as Tavily's hosted server does) or as `Title: …` / `URL: …` lines (its
    open-source one); anything else falls back to the bare URLs in the text.
    """
    found: list[dict[str, str]] = []
    seen: set[str] = set()
    with suppress(ValueError):  # not JSON
        _json_links(json.loads(text), found, seen)
    if found:
        return found
    title = ""
    for line in text.splitlines():
        if match := _TITLE_LINE.match(line):
            title = match.group(1)
        elif (match := _URL_LINE.match(line)) and match.group(1) not in seen:
            seen.add(match.group(1))
            found.append({"title": title, "url": match.group(1)})
            title = ""
    if not found:
        for url in _ANY_URL.findall(text):
            if url not in seen:
                seen.add(url)
                found.append({"title": "", "url": url})
    return found


#: Arguments that say what a call is about, most telling first.
_DETAIL_KEYS = ("query", "q", "search", "url", "urls", "prompt", "input")


def _detail(arguments: dict[str, Any]) -> str:
    """What a call was about, for its transcript line: the query or the URL
    when there is one, else its first string argument — not, say, a
    `topic: "general"` the model happened to send first."""
    for key in _DETAIL_KEYS:
        value = arguments.get(key)
        if isinstance(value, list):
            value = ", ".join(str(v) for v in value)
        if isinstance(value, str) and value.strip():
            return value.strip()[:160]
    for value in arguments.values():
        if isinstance(value, str) and value.strip():
            return value.strip()[:160]
    return ""


def describe(server: str, tool: str, arguments: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    """The transcript step for one call to a server's tool."""
    if not result.get("ok"):
        return {
            "kind": "failed",
            "tool": f"{server} · {tool}",
            "detail": _detail(arguments),
            "error": str(result.get("error", "")),
        }
    content = str(result.get("content", ""))
    found = links(content)
    return {
        "kind": "mcp",
        "server": server,
        "tool": tool,
        "detail": _detail(arguments),
        "count": len(found),
        "links": found[:MAX_LINKS],
        "chars": len(content),
    }
