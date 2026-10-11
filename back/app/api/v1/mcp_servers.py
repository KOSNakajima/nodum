"""MCP servers — remote tool servers the AI chat may call (Settings → MCP).

The other direction from `mcp_tokens`: those let an outside AI client call
Nodum; these let Nodum's chat call an outside server. Tokens go in and are
never sent back, only their hint.
"""

from typing import Any
from uuid import UUID

from fastapi import APIRouter, status
from pydantic import BaseModel, Field

from app.dependencies.auth import CurrentUserId
from app.dependencies.db import SessionDep
from app.services import mcp_connection_service

router = APIRouter()


class ServerCreateRequest(BaseModel):
    name: str = Field(max_length=64)
    url: str = Field(max_length=2048)
    token: str | None = Field(default=None, max_length=4096)


class ServerUpdateRequest(BaseModel):
    name: str | None = Field(default=None, max_length=64)
    url: str | None = Field(default=None, max_length=2048)
    # None keeps the stored token; "" removes it.
    token: str | None = Field(default=None, max_length=4096)
    enabled_tools: list[str] | None = Field(default=None, max_length=200)
    # Reconnect and re-read the tool list.
    refresh: bool = False


@router.get("")
async def list_servers(user_id: CurrentUserId, db: SessionDep) -> dict[str, Any]:
    return {"data": (await mcp_connection_service.list_servers(db, user_id)).unwrap()}


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_server(body: ServerCreateRequest, user_id: CurrentUserId, db: SessionDep) -> dict[str, Any]:
    """Connect to the server, read its tools, and store it."""
    result = await mcp_connection_service.create_server(db, user_id, name=body.name, url=body.url, token=body.token)
    return {"data": result.unwrap()}


@router.patch("/{server_id}")
async def update_server(
    server_id: UUID, body: ServerUpdateRequest, user_id: CurrentUserId, db: SessionDep
) -> dict[str, Any]:
    result = await mcp_connection_service.update_server(
        db,
        user_id,
        server_id,
        name=body.name,
        url=body.url,
        token=body.token,
        enabled_tools=body.enabled_tools,
        refresh=body.refresh,
    )
    return {"data": result.unwrap()}


@router.delete("/{server_id}")
async def delete_server(server_id: UUID, user_id: CurrentUserId, db: SessionDep) -> dict[str, Any]:
    return {"data": (await mcp_connection_service.delete_server(db, user_id, server_id)).unwrap()}
