"""mcp_servers: remote MCP servers the AI chat may call

Fork-only (KOSNakajima/nodum `custom`). The revision id is not a number so it
can never collide with upstream's next one; when upstream adds 0023 on top of
0022, `custom` needs an `alembic merge` revision joining the two heads.

Revision ID: k001
Revises: 0022
Create Date: 2026-10-11
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "k001"
down_revision: str | None = "0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "mcp_servers",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("token_ciphertext", sa.Text(), nullable=True),
        sa.Column("token_hint", sa.String(64), nullable=False, server_default=""),
        sa.Column("tools", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("enabled_tools", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_mcp_servers_user_id", "mcp_servers", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_mcp_servers_user_id", table_name="mcp_servers")
    op.drop_table("mcp_servers")
