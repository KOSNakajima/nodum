"""The streamed vault chat: SSE framing, tool status, the stored transcript —
with the provider stubbed at `ai_providers.stream_turn` (no network)."""

import json
import uuid

import pytest
from httpx import AsyncClient

from app.services import ai_providers

FAKE_KEY = "fake-provider-key-stream-test"


@pytest.fixture
async def account(client: AsyncClient) -> dict:
    creds = {"email": f"ai-stream-{uuid.uuid4().hex[:12]}@nodumtest.dev", "password": "s3cure-Password!", "name": "S"}
    resp = await client.post("/api/v1/auth/signup", json=creds)
    assert resp.status_code == 201, resp.text
    client.cookies.clear()
    headers = {"Authorization": f"Bearer {resp.json()['data']['access_token']}"}
    saved = await client.put(
        "/api/v1/ai/credentials",
        json={"provider": "openai", "api_key": FAKE_KEY, "model": "gpt-4.1"},
        headers=headers,
    )
    assert saved.status_code == 200, saved.text
    vault_id = (await client.get("/api/v1/vaults", headers=headers)).json()["data"][0]["id"]
    return {"headers": headers, "vault_id": vault_id}


def _events(text: str) -> list:
    out = []
    for block in text.split("\n\n"):
        if block.startswith("data: "):
            out.append(json.loads(block[6:]))
    return out


async def test_stream_emits_status_deltas_action_done_and_stores_the_turn(
    client: AsyncClient, account: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    rounds = {"n": 0}

    async def fake_stream_turn(**kw):
        rounds["n"] += 1
        if rounds["n"] == 1:
            # First round: the model calls a tool (no text worth keeping).
            yield ai_providers.Turn(
                text="",
                tool_calls=[
                    ai_providers.ToolCall(
                        id="c1", name="create_note", arguments={"title": "From the stream", "content": "hi"}
                    )
                ],
                raw_message={"role": "assistant", "content": None, "tool_calls": []},
            )
            return
        for piece in ["I wrote ", "the note ", "for you."]:
            yield piece
        yield ai_providers.Turn(
            text="I wrote the note for you.", tool_calls=[], raw_message={"role": "assistant", "content": "x"}
        )

    monkeypatch.setattr(ai_providers, "stream_turn", fake_stream_turn)

    async with client.stream(
        "POST",
        f"/api/v1/ai/vaults/{account['vault_id']}/chat/stream",
        json={"message": "write me a note"},
        headers=account["headers"],
    ) as resp:
        assert resp.status_code == 200, await resp.aread()
        assert resp.headers["content-type"].startswith("text/event-stream")
        body = (await resp.aread()).decode()
    events = _events(body)
    kinds = [e["type"] for e in events]
    assert kinds[0] == "status" and events[0]["tool"] == "create_note"
    assert "action" in kinds
    assert [e["text"] for e in events if e["type"] == "delta"] == ["I wrote ", "the note ", "for you."]
    done = events[-1]
    assert done["type"] == "done" and done["reply"] == "I wrote the note for you."
    assert done["actions"][0]["title"] == "From the stream"

    # The turn is stored exactly like the non-streamed one.
    convo = (
        await client.get(
            f"/api/v1/ai/vaults/{account['vault_id']}/conversations/{done['conversation_id']}",
            headers=account["headers"],
        )
    ).json()["data"]
    assert [m["role"] for m in convo["messages"]] == ["user", "assistant"]
    assert convo["messages"][1]["content"] == "I wrote the note for you."
    # And the note really exists.
    notes = (await client.get(f"/api/v1/vaults/{account['vault_id']}/tree", headers=account["headers"])).json()["data"]
    titles = [i["title"] for i in notes["items"] if i["type"] == "note"]
    assert "From the stream" in titles


async def test_stream_provider_failure_is_an_error_event_and_nothing_is_stored(
    client: AsyncClient, account: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def failing(**kw):
        yield "partial "
        raise ai_providers.ProviderError("The provider is rate-limiting this key. Try again shortly.")

    monkeypatch.setattr(ai_providers, "stream_turn", failing)
    async with client.stream(
        "POST",
        f"/api/v1/ai/vaults/{account['vault_id']}/chat/stream",
        json={"message": "hello"},
        headers=account["headers"],
    ) as resp:
        body = (await resp.aread()).decode()
    events = _events(body)
    assert events[0] == {"type": "delta", "text": "partial "}
    assert events[-1]["type"] == "error" and "rate-limiting" in events[-1]["message"]
    listed = (
        await client.get(f"/api/v1/ai/vaults/{account['vault_id']}/conversations", headers=account["headers"])
    ).json()["data"]
    assert listed == []


async def test_json_endpoint_still_answers_whole(
    client: AsyncClient, account: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def one_shot(**kw):
        yield "Whole "
        yield "answer."
        yield ai_providers.Turn(text="Whole answer.", tool_calls=[], raw_message=None)

    monkeypatch.setattr(ai_providers, "stream_turn", one_shot)
    resp = await client.post(
        f"/api/v1/ai/vaults/{account['vault_id']}/chat", json={"message": "hi"}, headers=account["headers"]
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["reply"] == "Whole answer."


async def test_a_failure_after_a_tool_ran_leaves_no_empty_thread(
    client: AsyncClient, account: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    rounds = {"n": 0}

    async def tool_then_fail(**kw):
        rounds["n"] += 1
        if rounds["n"] == 1:
            yield ai_providers.Turn(
                text="",
                tool_calls=[
                    ai_providers.ToolCall(id="c1", name="create_note", arguments={"title": "Half done", "content": "x"})
                ],
                raw_message={"role": "assistant", "content": None, "tool_calls": []},
            )
            return
        raise ai_providers.ProviderError("The provider is having trouble right now (500).")
        yield  # pragma: no cover

    monkeypatch.setattr(ai_providers, "stream_turn", tool_then_fail)
    async with client.stream(
        "POST",
        f"/api/v1/ai/vaults/{account['vault_id']}/chat/stream",
        json={"message": "write then fail"},
        headers=account["headers"],
    ) as resp:
        events = _events((await resp.aread()).decode())
    assert events[-1]["type"] == "error"
    # The note the tool wrote exists (it was committed) — but no empty thread
    # is left in the list.
    listed = (
        await client.get(f"/api/v1/ai/vaults/{account['vault_id']}/conversations", headers=account["headers"])
    ).json()["data"]
    assert listed == [], listed


async def test_thinking_is_streamed_and_recorded_as_a_thought_step(
    client: AsyncClient, account: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list = []

    async def fake_stream_turn(**kw):
        seen.append(kw)
        yield ai_providers.Reasoning("**Weighing it**\n\n")
        yield ai_providers.Reasoning("It is 17 x 23.")
        yield "Not prime."
        yield ai_providers.Turn(text="Not prime.", tool_calls=[], raw_message=None)

    monkeypatch.setattr(ai_providers, "stream_turn", fake_stream_turn)

    async def turn(body: dict) -> list:
        async with client.stream(
            "POST", f"/api/v1/ai/vaults/{account['vault_id']}/chat/stream", json=body, headers=account["headers"]
        ) as resp:
            assert resp.status_code == 200, await resp.aread()
            return _events((await resp.aread()).decode())

    events = await turn({"message": "Is 391 prime?", "reasoning_effort": "high"})
    assert seen[0]["reasoning_effort"] == "high"
    kinds = [e["type"] for e in events]
    # Thinking streams first, then the thought step, then the reply.
    assert kinds.index("thinking") < kinds.index("action") < kinds.index("delta")
    thought = events[-1]["actions"][0]
    assert thought["kind"] == "thought" and thought["seconds"] >= 1
    assert thought["text"] == "**Weighing it**\n\nIt is 17 x 23."

    # Thinking off: reasoning that arrives anyway is neither streamed nor kept.
    events = await turn({"message": "again"})
    assert seen[1]["reasoning_effort"] is None
    assert "thinking" not in [e["type"] for e in events]
    assert events[-1]["actions"] == []


@pytest.mark.parametrize(
    ("summary", "reasoning_tokens", "recorded"),
    [
        ("", 0, None),  # it did not reason (easy question): no thought at all
        ("", 22, ""),  # it reasoned but shared no summary: the step, without text
    ],
)
async def test_a_thought_is_recorded_only_when_the_model_reasoned(
    client: AsyncClient,
    account: dict,
    monkeypatch: pytest.MonkeyPatch,
    summary: str,
    reasoning_tokens: int,
    recorded: str | None,
) -> None:
    async def fake_stream_turn(**kw):
        if summary:
            yield ai_providers.Reasoning(summary)
        yield "Hello."
        yield ai_providers.Turn(text="Hello.", tool_calls=[], raw_message=None, reasoning_tokens=reasoning_tokens)

    monkeypatch.setattr(ai_providers, "stream_turn", fake_stream_turn)
    async with client.stream(
        "POST",
        f"/api/v1/ai/vaults/{account['vault_id']}/chat/stream",
        json={"message": "hi", "reasoning_effort": "high"},
        headers=account["headers"],
    ) as resp:
        events = _events((await resp.aread()).decode())
    thoughts = [a for a in events[-1]["actions"] if a["kind"] == "thought"]
    if recorded is None:
        assert thoughts == []
    else:
        assert [t["text"] for t in thoughts] == [recorded]
