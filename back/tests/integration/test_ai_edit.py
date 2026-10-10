"""Selection-aware chat and edit_note: the selected lines reach the model, the
user's message records what went along, and an edit replaces exactly one
passage after snapshotting the note — provider stubbed, no network."""

import json
import uuid

import pytest
from httpx import AsyncClient

from app.services import ai_providers

FAKE_KEY = "fake-provider-key-edit-test"
BODY = "# Plan\nfirst line\nteh second line\nteh third line\nlast line\n"


@pytest.fixture
async def account(client: AsyncClient) -> dict:
    creds = {"email": f"ai-edit-{uuid.uuid4().hex[:12]}@nodumtest.dev", "password": "s3cure-Password!", "name": "E"}
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
    note = await client.post(
        f"/api/v1/vaults/{vault_id}/notes", json={"title": "Plan", "content": BODY}, headers=headers
    )
    assert note.status_code == 201, note.text
    return {"headers": headers, "vault_id": vault_id, "note_id": note.json()["data"]["id"]}


def _model(*calls: ai_providers.ToolCall, reply: str = "Done.", seen: list | None = None):
    """A stub provider: one round per tool call, then a plain reply."""
    rounds = {"n": 0}

    async def stream_turn(**kw):
        if seen is not None:
            seen.append(kw)
        i = rounds["n"]
        rounds["n"] += 1
        if i < len(calls):
            yield ai_providers.Turn(text="", tool_calls=[calls[i]], raw_message={"role": "assistant", "content": None})
            return
        yield reply
        yield ai_providers.Turn(text=reply, tool_calls=[], raw_message={"role": "assistant", "content": reply})

    return stream_turn


async def _chat(client: AsyncClient, account: dict, body: dict) -> list[dict]:
    async with client.stream(
        "POST",
        f"/api/v1/ai/vaults/{account['vault_id']}/chat/stream",
        json=body,
        headers=account["headers"],
    ) as resp:
        assert resp.status_code == 200, await resp.aread()
        text = (await resp.aread()).decode()
    return [json.loads(b[6:]) for b in text.split("\n\n") if b.startswith("data: ")]


async def _content(client: AsyncClient, account: dict) -> str:
    note = await client.get(
        f"/api/v1/vaults/{account['vault_id']}/notes/{account['note_id']}", headers=account["headers"]
    )
    return note.json()["data"]["content"]


async def test_selection_reaches_the_model_and_the_edit_replaces_it(
    client: AsyncClient, account: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    selected = "teh second line\nteh third line"
    seen: list = []
    edit = ai_providers.ToolCall(
        id="e1",
        name="edit_note",
        arguments={"title": "Plan", "old_text": selected, "new_text": "the second and third line"},
    )
    monkeypatch.setattr(ai_providers, "stream_turn", _model(edit, seen=seen))

    events = await _chat(
        client,
        account,
        {
            "message": "ここを直して",
            "note_id": account["note_id"],
            "selection": {"from_line": 3, "to_line": 4, "text": selected},
        },
    )

    # The model was told which lines, of which note, and given them verbatim.
    system = seen[0]["system"]
    assert 'lines 3-4 of "Plan"' in system and selected in system

    done = events[-1]
    assert done["type"] == "done"
    assert done["actions"] == [
        {"kind": "edited", "title": "Plan", "note_id": account["note_id"], "removed": 2, "added": 1}
    ]
    assert await _content(client, account) == "# Plan\nfirst line\nthe second and third line\nlast line\n"

    # The pre-edit body is restorable from the versions panel.
    versions = (
        await client.get(
            f"/api/v1/vaults/{account['vault_id']}/notes/{account['note_id']}/versions",
            headers=account["headers"],
        )
    ).json()["data"]
    first = (
        await client.get(
            f"/api/v1/vaults/{account['vault_id']}/notes/{account['note_id']}/versions/{versions[0]['id']}",
            headers=account["headers"],
        )
    ).json()["data"]
    assert first["content"] == BODY

    # The user's message records what went along with it.
    convo = (
        await client.get(
            f"/api/v1/ai/vaults/{account['vault_id']}/conversations/{done['conversation_id']}",
            headers=account["headers"],
        )
    ).json()["data"]
    assert convo["messages"][0]["actions"] == [
        {"kind": "context", "title": "Plan", "note_id": account["note_id"], "from_line": 3, "to_line": 4}
    ]


async def test_open_note_without_selection_is_recorded_without_lines(
    client: AsyncClient, account: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list = []
    monkeypatch.setattr(ai_providers, "stream_turn", _model(seen=seen))
    events = await _chat(client, account, {"message": "summarise", "note_id": account["note_id"]})
    assert "<selection>" not in seen[0]["system"]
    convo = (
        await client.get(
            f"/api/v1/ai/vaults/{account['vault_id']}/conversations/{events[-1]['conversation_id']}",
            headers=account["headers"],
        )
    ).json()["data"]
    assert convo["messages"][0]["actions"] == [{"kind": "context", "title": "Plan", "note_id": account["note_id"]}]


@pytest.mark.parametrize(
    ("old_text", "error"),
    [
        ("teh", "appears 2 times"),  # ambiguous
        ("not in the note", "not in the note"),
        ("", "old_text is empty"),
    ],
)
async def test_edit_refuses_passages_that_do_not_match_exactly_once(
    client: AsyncClient, account: dict, monkeypatch: pytest.MonkeyPatch, old_text: str, error: str
) -> None:
    edit = ai_providers.ToolCall(
        id="e1", name="edit_note", arguments={"title": "Plan", "old_text": old_text, "new_text": "x"}
    )
    monkeypatch.setattr(ai_providers, "stream_turn", _model(edit))
    events = await _chat(client, account, {"message": "fix it"})
    [action] = events[-1]["actions"]
    assert action["kind"] == "failed" and action["tool"] == "edit_note"
    assert error in action["error"]
    assert await _content(client, account) == BODY


async def test_a_note_from_another_vault_is_not_attached(
    client: AsyncClient, account: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(ai_providers, "stream_turn", _model())
    events = await _chat(client, account, {"message": "hi", "note_id": str(uuid.uuid4())})
    convo = (
        await client.get(
            f"/api/v1/ai/vaults/{account['vault_id']}/conversations/{events[-1]['conversation_id']}",
            headers=account["headers"],
        )
    ).json()["data"]
    assert convo["messages"][0]["actions"] == []
