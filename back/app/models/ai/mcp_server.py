"""MCP servers the AI chat may call — Nodum as an MCP *client*.

The other direction from `app/mcp`, where Nodum is the server. A user registers
a remote MCP server (Tavily, say) with its URL and, usually, a bearer token;
the chat then offers that server's tools to the model and runs them here, on
the server, so the token never reaches the browser.

Its own table rather than `users.settings`, for the same reason as
`ai_credentials`: that blob goes to the browser and the browser can write it,
and the token must be readable only by the server (ciphertext, `crypto_utils`).
"""

from typing import Any
from uuid import UUID as UUIDType

from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDMixin


class MCPServer(UUIDMixin, TimestampMixin, Base):
    """One remote MCP server registered by a user, for every vault they chat in."""

    __tablename__ = "mcp_servers"

    user_id: Mapped[UUIDType] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # What the chat calls it: "Tavily". Shown on every step it takes.
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    # The Streamable HTTP endpoint. Checked against private networks when saved
    # and again before every connection (see url_guard).
    url: Mapped[str] = mapped_column(Text, nullable=False)
    # `v1:<fernet token>` sent as `Authorization: Bearer …`; NULL for a server
    # that needs none. Never returned by any endpoint.
    token_ciphertext: Mapped[str | None] = mapped_column(Text, nullable=True, default=None)
    token_hint: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    # The server's tool list as of the last connect — [{name, description,
    # input_schema}] — so a chat turn need not ask for it every time.
    tools: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    # Names of the tools the chat may use. A tool the server adds later starts off.
    enabled_tools: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")

    def __repr__(self) -> str:
        return f"<MCPServer {self.name} user={self.user_id}>"
