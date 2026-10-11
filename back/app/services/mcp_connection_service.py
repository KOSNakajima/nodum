"""The MCP servers a user has connected for the AI chat (Settings → MCP).

Registering one connects to it straight away and stores its tool list, so a
bad URL or token is reported on the form rather than in the middle of a chat,
and a chat turn does not ask the server for its tools each time.
"""

from typing import Any
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai import MCPServer
from app.services import mcp_client
from app.services.service_response import ServiceResponse
from app.utils.crypto_utils import decrypt_secret, encrypt_secret, encryption_available, mask_secret

MAX_SERVERS = 10
MAX_NAME_CHARS = 64


def _public(server: MCPServer) -> dict[str, Any]:
    """A server as the settings screen sees it — never the token."""
    return {
        "id": str(server.id),
        "name": server.name,
        "url": server.url,
        "token_hint": server.token_hint,
        "tools": [{"name": t["name"], "description": t.get("description", "")} for t in server.tools],
        "enabled_tools": list(server.enabled_tools),
        "updated_at": server.updated_at.isoformat() if server.updated_at else None,
    }


async def _owned(db: AsyncSession, user_id: UUID, server_id: UUID) -> MCPServer | None:
    server = await db.get(MCPServer, server_id)
    return server if server is not None and server.user_id == user_id else None


def _token(server: MCPServer) -> str | None:
    return decrypt_secret(server.token_ciphertext) if server.token_ciphertext else None


async def list_servers(db: AsyncSession, user_id: UUID) -> ServiceResponse[list[dict[str, Any]]]:
    rows = await db.scalars(select(MCPServer).where(MCPServer.user_id == user_id).order_by(MCPServer.created_at))
    return ServiceResponse.ok([_public(s) for s in rows])


async def create_server(
    db: AsyncSession, user_id: UUID, *, name: str, url: str, token: str | None
) -> ServiceResponse[dict[str, Any]]:
    """Connect, read the tool list, and store the server with every tool on."""
    name, url, token = name.strip(), url.strip(), (token or "").strip() or None
    if not name or len(name) > MAX_NAME_CHARS:
        return ServiceResponse.fail("validation_failed", "Give the server a name (up to 64 characters).")
    if not url:
        return ServiceResponse.fail("validation_failed", "Enter the server's URL.")
    count = await db.scalar(select(func.count()).select_from(MCPServer).where(MCPServer.user_id == user_id))
    if (count or 0) >= MAX_SERVERS:
        return ServiceResponse.fail("validation_failed", f"You can connect up to {MAX_SERVERS} servers.")
    if token and not encryption_available():
        return ServiceResponse.fail(
            "validation_failed",
            "This server has no AI_ENCRYPTION_KEY configured, so it cannot store a token safely.",
        )
    try:
        tools = await mcp_client.list_tools(url, token)
    except mcp_client.MCPClientError as exc:
        return ServiceResponse.fail("validation_failed", f"Could not connect: {exc}")
    server = MCPServer(
        user_id=user_id,
        name=name,
        url=url,
        token_ciphertext=encrypt_secret(token) if token else None,
        token_hint=mask_secret(token) if token else "",
        tools=tools,
        enabled_tools=[t["name"] for t in tools],
    )
    db.add(server)
    await db.commit()
    await db.refresh(server)
    return ServiceResponse.ok(_public(server))


async def update_server(
    db: AsyncSession,
    user_id: UUID,
    server_id: UUID,
    *,
    name: str | None = None,
    url: str | None = None,
    token: str | None = None,
    enabled_tools: list[str] | None = None,
    refresh: bool = False,
) -> ServiceResponse[dict[str, Any]]:
    """Rename, re-point, re-key, pick tools, or re-read the tool list.

    A new URL or token (or `refresh`) reconnects; tools the server has added
    since start off, and those it dropped are forgotten. `token=""` removes
    the token; None keeps it.
    """
    server = await _owned(db, user_id, server_id)
    if server is None:
        return ServiceResponse.fail("not_found", "MCP server not found.")
    if name is not None:
        name = name.strip()
        if not name or len(name) > MAX_NAME_CHARS:
            return ServiceResponse.fail("validation_failed", "Give the server a name (up to 64 characters).")
        server.name = name
    new_url = url.strip() if url is not None else server.url
    if not new_url:
        return ServiceResponse.fail("validation_failed", "Enter the server's URL.")
    new_token = _token(server) if token is None else (token.strip() or None)
    if token and not encryption_available():
        return ServiceResponse.fail(
            "validation_failed",
            "This server has no AI_ENCRYPTION_KEY configured, so it cannot store a token safely.",
        )

    if refresh or new_url != server.url or token is not None:
        try:
            tools = await mcp_client.list_tools(new_url, new_token)
        except mcp_client.MCPClientError as exc:
            return ServiceResponse.fail("validation_failed", f"Could not connect: {exc}")
        if new_url == server.url:
            # Same server: keep the user's picks; a tool it has added since
            # starts off rather than being handed to the model unseen.
            kept = set(server.enabled_tools)
            server.enabled_tools = [t["name"] for t in tools if t["name"] in kept]
        else:
            # A different server: start like a new one, everything on.
            server.enabled_tools = [t["name"] for t in tools]
        server.tools = tools
        server.url = new_url
        if token is not None:
            server.token_ciphertext = encrypt_secret(new_token) if new_token else None
            server.token_hint = mask_secret(new_token) if new_token else ""

    if enabled_tools is not None:
        offered = {t["name"] for t in server.tools}
        server.enabled_tools = [n for n in dict.fromkeys(enabled_tools) if n in offered]

    await db.commit()
    await db.refresh(server)
    return ServiceResponse.ok(_public(server))


async def delete_server(db: AsyncSession, user_id: UUID, server_id: UUID) -> ServiceResponse[dict[str, Any]]:
    server = await _owned(db, user_id, server_id)
    if server is None:
        return ServiceResponse.fail("not_found", "MCP server not found.")
    await db.delete(server)
    await db.commit()
    return ServiceResponse.ok({"id": str(server_id)})


class ChatTool:
    """One server tool offered to the model in a chat turn."""

    def __init__(self, server: MCPServer, token: str | None, tool: dict[str, Any], name: str) -> None:
        self.server_name = server.name
        self.url = server.url
        self.token = token
        self.tool = tool["name"]
        self.declaration = {
            "name": name,
            "description": f"[{server.name}, an external MCP server] {tool.get('description', '')}".strip(),
            "parameters": tool.get("input_schema") or {"type": "object", "properties": {}},
        }


async def chat_tools(db: AsyncSession, user_id: UUID, server_ids: list[UUID] | None) -> dict[str, ChatTool]:
    """The enabled tools of the servers chosen for this turn, by the name the
    model calls them. `server_ids=None` means all of the user's servers."""
    query = select(MCPServer).where(MCPServer.user_id == user_id).order_by(MCPServer.created_at)
    if server_ids is not None:
        if not server_ids:
            return {}
        query = query.where(MCPServer.id.in_(server_ids))
    tools: dict[str, ChatTool] = {}
    for index, server in enumerate(await db.scalars(query), start=1):
        token = _token(server)
        if server.token_ciphertext and token is None:
            # Unreadable (the encryption key changed): offering its tools
            # would only produce 401s.
            continue
        enabled = set(server.enabled_tools)
        for tool in server.tools:
            if tool["name"] in enabled:
                name = mcp_client.chat_tool_name(index, tool["name"])
                tools[name] = ChatTool(server, token, tool, name)
    return tools
