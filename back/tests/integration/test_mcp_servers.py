"""Settings → MCP servers, and their tools in the vault chat — with the remote
server replaced by an in-process one (`mcp_client.connect`) and the provider
stubbed at `ai_providers.stream_turn`."""

import json
import uuid
from contextlib import asynccontextmanager

import pytest
from httpx import AsyncClient
from mcp.client import Client
from mcp.server.mcpserver import MCPServer

from app.services import ai_providers, mcp_client

TOKEN = "tvly-secret-token-for-tests"
RESULTS = "Detailed Results:\n\nTitle: Logseq\nURL: https://logseq.com/\nContent: Outliner."


class Remote:
    """The stand-in server, and what each connection to it carried."""

    def __init__(self) -> None:
        self.server = MCPServer("stub")
        self.seen: list[tuple[str, str | None]] = []
        self.queries: list[str] = []

        @self.server.tool()
        def web_search(query: str) -> str:
            """Search the web."""
            self.queries.append(query)
            return RESULTS

        @self.server.tool()
        def crawl(url: str) -> str:
            """Crawl a site."""
            return "crawled"


@pytest.fixture
def remote(monkeypatch: pytest.MonkeyPatch) -> Remote:
    stub = Remote()

    @asynccontextmanager
    async def connect(url, token):
        if "unreachable" in url:
            raise mcp_client.MCPClientError("Could not reach the server.")
        stub.seen.append((url, token))
        async with Client(stub.server) as client:
            yield client

    monkeypatch.setattr(mcp_client, "connect", connect)
    return stub


async def _account(client: AsyncClient) -> dict:
    creds = {"email": f"mcp-{uuid.uuid4().hex[:12]}@nodumtest.dev", "password": "s3cure-Password!", "name": "M"}
    resp = await client.post("/api/v1/auth/signup", json=creds)
    assert resp.status_code == 201, resp.text
    client.cookies.clear()
    headers = {"Authorization": f"Bearer {resp.json()['data']['access_token']}"}
    vault_id = (await client.get("/api/v1/vaults", headers=headers)).json()["data"][0]["id"]
    return {"headers": headers, "vault_id": vault_id}


@pytest.fixture
async def account(client: AsyncClient) -> dict:
    return await _account(client)


async def _add(client: AsyncClient, account: dict, **body) -> dict:
    payload = {"name": "Tavily", "url": "https://mcp.tavily.example/mcp/", "token": TOKEN, **body}
    resp = await client.post("/api/v1/mcp-servers", json=payload, headers=account["headers"])
    assert resp.status_code == 201, resp.text
    return resp.json()["data"]


async def test_adding_a_server_connects_lists_its_tools_and_hides_the_token(
    client: AsyncClient, account: dict, remote: Remote
) -> None:
    server = await _add(client, account)
    assert remote.seen == [("https://mcp.tavily.example/mcp/", TOKEN)]
    assert [t["name"] for t in server["tools"]] == ["web_search", "crawl"]
    assert server["enabled_tools"] == ["web_search", "crawl"]
    assert server["token_hint"] and TOKEN not in json.dumps(server)

    listed = (await client.get("/api/v1/mcp-servers", headers=account["headers"])).json()["data"]
    assert [s["id"] for s in listed] == [server["id"]]
    assert TOKEN not in json.dumps(listed)


async def test_a_server_that_cannot_be_reached_is_not_saved(client: AsyncClient, account: dict, remote: Remote) -> None:
    resp = await client.post(
        "/api/v1/mcp-servers",
        json={"name": "Down", "url": "https://unreachable.example/mcp"},
        headers=account["headers"],
    )
    assert resp.status_code == 422
    assert "Could not reach the server" in resp.json()["error"]["message"]
    assert (await client.get("/api/v1/mcp-servers", headers=account["headers"])).json()["data"] == []


async def test_tools_can_be_switched_and_a_refresh_keeps_the_choice(
    client: AsyncClient, account: dict, remote: Remote
) -> None:
    server = await _add(client, account)
    url = f"/api/v1/mcp-servers/{server['id']}"
    picked = await client.patch(url, json={"enabled_tools": ["web_search", "not-offered"]}, headers=account["headers"])
    assert picked.json()["data"]["enabled_tools"] == ["web_search"]

    # The server grows a tool; a refresh lists it, switched off.
    @remote.server.tool()
    def research(topic: str) -> str:
        return "long"

    refreshed = (await client.patch(url, json={"refresh": True}, headers=account["headers"])).json()["data"]
    assert [t["name"] for t in refreshed["tools"]] == ["web_search", "crawl", "research"]
    assert refreshed["enabled_tools"] == ["web_search"]
    # The stored token was used for the reconnect.
    assert remote.seen[-1] == ("https://mcp.tavily.example/mcp/", TOKEN)


async def test_another_user_cannot_see_change_or_delete_a_server(
    client: AsyncClient, account: dict, remote: Remote
) -> None:
    server = await _add(client, account)
    other = await _account(client)
    url = f"/api/v1/mcp-servers/{server['id']}"
    assert (await client.get("/api/v1/mcp-servers", headers=other["headers"])).json()["data"] == []
    assert (await client.patch(url, json={"name": "Mine"}, headers=other["headers"])).status_code == 404
    assert (await client.delete(url, headers=other["headers"])).status_code == 404
    assert (await client.delete(url, headers=account["headers"])).status_code == 200
    assert (await client.get("/api/v1/mcp-servers", headers=account["headers"])).json()["data"] == []


def _events(text: str) -> list:
    return [json.loads(block[6:]) for block in text.split("\n\n") if block.startswith("data: ")]


async def _chat(client: AsyncClient, account: dict, **body) -> list:
    async with client.stream(
        "POST",
        f"/api/v1/ai/vaults/{account['vault_id']}/chat/stream",
        json={"message": "find obsidian alternatives", **body},
        headers=account["headers"],
    ) as resp:
        assert resp.status_code == 200, await resp.aread()
        return _events((await resp.aread()).decode())


async def test_the_chat_offers_enabled_tools_and_records_the_call_as_a_step(
    client: AsyncClient, account: dict, remote: Remote, monkeypatch: pytest.MonkeyPatch
) -> None:
    saved = await client.put(
        "/api/v1/ai/credentials",
        json={"provider": "openai", "api_key": "fake-provider-key", "model": "gpt-4.1"},
        headers=account["headers"],
    )
    assert saved.status_code == 200, saved.text
    server = await _add(client, account)
    await client.patch(
        f"/api/v1/mcp-servers/{server['id']}", json={"enabled_tools": ["web_search"]}, headers=account["headers"]
    )
    offered: list[list[str]] = []
    rounds = {"n": 0}

    async def fake_stream_turn(**kw):
        offered.append([t["name"] for t in kw["tools"]])
        rounds["n"] += 1
        if rounds["n"] == 1:
            yield ai_providers.Turn(
                text="",
                tool_calls=[ai_providers.ToolCall(id="c1", name="mcp1_web_search", arguments={"query": "notes apps"})],
                raw_message={"role": "assistant", "content": None, "tool_calls": []},
            )
            return
        # The search result went back to the model.
        assert "https://logseq.com/" in kw["messages"][-1].content
        yield ai_providers.Turn(text="Try Logseq.", tool_calls=[], raw_message={"role": "assistant", "content": "x"})

    monkeypatch.setattr(ai_providers, "stream_turn", fake_stream_turn)
    events = await _chat(client, account)

    assert "mcp1_web_search" in offered[0] and "mcp1_crawl" not in offered[0]
    assert remote.queries == ["notes apps"]
    assert remote.seen[-1] == ("https://mcp.tavily.example/mcp/", TOKEN)
    status = next(e for e in events if e["type"] == "status")
    assert status["text"] == "Tavily · web_search…"
    done = events[-1]
    assert done["type"] == "done" and done["reply"] == "Try Logseq."
    step = done["actions"][0]
    assert step["kind"] == "mcp" and step["server"] == "Tavily" and step["tool"] == "web_search"
    assert step["detail"] == "notes apps" and step["links"] == [{"title": "Logseq", "url": "https://logseq.com/"}]


async def test_a_turn_can_leave_the_servers_out(
    client: AsyncClient, account: dict, remote: Remote, monkeypatch: pytest.MonkeyPatch
) -> None:
    await client.put(
        "/api/v1/ai/credentials",
        json={"provider": "openai", "api_key": "fake-provider-key", "model": "gpt-4.1"},
        headers=account["headers"],
    )
    await _add(client, account)
    offered: list[list[str]] = []

    async def fake_stream_turn(**kw):
        offered.append([t["name"] for t in kw["tools"]])
        yield ai_providers.Turn(text="ok", tool_calls=[], raw_message={"role": "assistant", "content": "ok"})

    monkeypatch.setattr(ai_providers, "stream_turn", fake_stream_turn)
    await _chat(client, account, mcp_servers=[])
    assert not any(name.startswith("mcp") for name in offered[0])
    await _chat(client, account)
    assert "mcp1_web_search" in offered[1]
