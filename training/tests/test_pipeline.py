from aro_training.bootstrap import build_oasst_threads, load_identity
from aro_training.clean import clean, mix_with_replay, scrub
from aro_training.evaluate import ItemResult, decide, load_eval_set, rubric_score
from aro_training.export import Conversation, build_examples
from aro_training.prepare import build_training_set
from aro_training.promote import next_pointer, rollback_pointer

SYSTEM = "You are ARO."


def msg(role, content, **extra):
    return {"role": role, "content": content, **extra}


# ------------------------------------------------------------------ export

def test_only_rated_aro_answers_from_consenting_users_are_used():
    convo = Conversation(
        id="c1",
        owner_id="user-123",
        messages=[
            msg("user", "What is 2+2?"),
            msg("assistant", "4", id="a1", servedBy="aro", rating=1),
            msg("user", "Capital of Ghana?"),
            msg("assistant", "Lagos", id="a2", servedBy="aro", rating=-1, correction="Accra"),
            msg("user", "Tell me a joke"),
            msg("assistant", "unrated", id="a3", servedBy="aro"),
            msg("user", "And from Claude?"),
            msg("assistant", "claude answer", id="a4", servedBy="claude", rating=1),
            msg("user", "Backup?"),
            msg("assistant", "backup answer", id="a5", servedBy="fallback", rating=1),
        ],
    )
    result = build_examples([convo], SYSTEM)

    answers = [e["messages"][-1]["content"] for e in result.sft]
    assert answers == ["4", "Accra"]
    assert result.preferences == [
        {"prompt": result.sft[1]["messages"][:-1], "chosen": "Accra", "rejected": "Lagos", "source": result.preferences[0]["source"], "model": "aro-1.5"}
    ]
    assert result.skipped_unrated == 1
    assert result.skipped_not_aro == 2
    # Context includes the earlier turns, and never the user's id.
    assert result.sft[1]["messages"][0] == {"role": "system", "content": SYSTEM}
    assert result.sft[1]["messages"][1]["content"] == "What is 2+2?"
    assert "user-123" not in str(result.sft)


def test_reply_without_a_preceding_user_turn_is_skipped():
    convo = Conversation(id="c", owner_id="u", messages=[msg("assistant", "hello", servedBy="aro", rating=1)])
    assert build_examples([convo], SYSTEM).sft == []


# ------------------------------------------------------------------- clean

def test_scrub_removes_personal_data_and_secrets():
    text = (
        "Email me at ada@example.com or call +234 803 123 4567. "
        "Key sk-proj-abcdefghijklmnopqrstuvwxyz123456 token github_pat_11ABCDEFGHIJKLMNOPQRSTUV_xyz "
        "password: hunter2 card 4111 1111 1111 1111 server 10.0.0.12"
    )
    cleaned = scrub(text)
    for leaked in ["ada@example.com", "803 123 4567", "sk-proj-", "github_pat_", "hunter2", "4111", "10.0.0.12"]:
        assert leaked not in cleaned, leaked
    assert "[EMAIL]" in cleaned and "[SECRET]" in cleaned


def test_clean_dedupes_and_drops_junk():
    good = {"messages": [msg("system", SYSTEM), msg("user", "Hi  there"), msg("assistant", "Hello!")]}
    same = {"messages": [msg("system", SYSTEM), msg("user", "hi there"), msg("assistant", "hello!")]}
    error = {"messages": [msg("user", "x"), msg("assistant", "No API key set for claude")]}
    no_answer = {"messages": [msg("user", "x")]}
    assert len(clean([good, same, error, no_answer])) == 1


def test_replay_mix_hits_the_requested_ratio():
    new = [{"messages": [msg("user", f"n{i}"), msg("assistant", "a")]} for i in range(10)]
    old = [{"messages": [msg("user", f"o{i}"), msg("assistant", "a")]} for i in range(100)]
    mixed = mix_with_replay(new, old, replay_ratio=0.5)
    assert len(mixed) == 20
    assert sum(1 for e in mixed if e["messages"][0]["content"].startswith("n")) == 10


def test_prepare_first_run_uses_starter_and_later_runs_need_new_data():
    starter = [{"messages": [msg("system", SYSTEM), msg("user", f"q{i}"), msg("assistant", f"a{i}")]} for i in range(5)]
    identity = load_identity(SYSTEM)

    today, history = build_training_set([], [], starter, identity)
    assert len(history) == 5
    assert len(today) == 5 + len(identity)

    nothing, same_history = build_training_set([], history, [], identity)
    assert nothing == [] and same_history == history

    fresh = [{"messages": [msg("system", SYSTEM), msg("user", "new q"), msg("assistant", "new a")]}]
    today2, history2 = build_training_set(fresh, history, [], identity)
    assert len(history2) == 6
    assert any(e["messages"][-1]["content"] == "new a" for e in today2)


# --------------------------------------------------------------- bootstrap

def test_oasst_threads_follow_best_ranked_replies():
    rows = [
        {"message_id": "p1", "parent_id": None, "role": "prompter", "text": "Hi?", "lang": "en"},
        {"message_id": "a1", "parent_id": "p1", "role": "assistant", "text": "worse", "rank": 1},
        {"message_id": "a2", "parent_id": "p1", "role": "assistant", "text": "best", "rank": 0},
        {"message_id": "p2", "parent_id": "a2", "role": "prompter", "text": "More?"},
        {"message_id": "a3", "parent_id": "p2", "role": "assistant", "text": "more", "rank": 0},
        {"message_id": "x", "parent_id": None, "role": "prompter", "text": "deleted", "lang": "en", "deleted": True},
        {"message_id": "de", "parent_id": None, "role": "prompter", "text": "Hallo", "lang": "de"},
        {"message_id": "s1", "parent_id": "p2", "role": "assistant", "text": "synthetic", "rank": -1, "synthetic": True},
    ]
    examples = build_oasst_threads(rows, SYSTEM, langs={"en"})
    assert [e["messages"][-1]["content"] for e in examples] == ["best", "more"]
    assert [m["role"] for m in examples[1]["messages"]] == ["system", "user", "assistant", "user", "assistant"]


def test_identity_seed_is_valid():
    identity = load_identity(SYSTEM)
    assert len(identity) >= 10
    by_question = {e["messages"][1]["content"]: e["messages"][-1]["content"] for e in identity}
    for question in ["Who are you?", "What model are you?", "Are you ChatGPT?", "What's your name?"]:
        assert "ARO" in by_question[question]
    for answer in by_question.values():
        for claim in ["I am Qwen", "I'm Qwen", "I am ChatGPT", "I'm Claude", "I am Claude"]:
            assert claim not in answer


# ---------------------------------------------------------------- evaluate

def test_rubric_scoring():
    item = {"must_include": ["Abuja"], "must_not_include": ["Lagos is the capital"]}
    assert rubric_score("The capital is Abuja.", item) == 1.0
    assert rubric_score("Lagos is the capital", item) == 0.0
    assert rubric_score("", {"must_include": []}) == 0.0
    assert rubric_score("git switch -c feature", {"must_include": ["git checkout -b feature|git switch -c feature"]}) == 1.0


def test_decide_requires_margin_and_no_critical_regressions():
    better = [ItemResult("a", "x", False, 1.0, 0.5), ItemResult("b", "x", False, 1.0, 1.0)]
    assert decide(better, margin=0.02).promote

    tied = [ItemResult("a", "x", False, 1.0, 1.0)]
    assert not decide(tied, margin=0.02).promote

    regress = [ItemResult("id", "identity", True, 0.5, 1.0), ItemResult("b", "x", False, 1.0, 0.0)]
    decision = decide(regress, margin=0.0)
    assert not decision.promote and "critical" in decision.reason

    judged = [ItemResult("a", "x", False, 1.0, 1.0, judge="candidate")]
    assert decide(judged, margin=0.02).promote


def test_eval_set_is_well_formed():
    items = load_eval_set()
    assert len(items) >= 20
    assert len({i["id"] for i in items}) == len(items)
    assert any(i.get("critical") for i in items)
    for item in items:
        assert item["prompt"].strip()


# ----------------------------------------------------------------- promote

def test_version_pointer_and_rollback():
    p = next_pointer(None, "v1")
    p = next_pointer(p, "v2")
    assert p["version"] == "v2"
    back = rollback_pointer(p)
    assert back["version"] == "v1"
    assert back["history"][-1]["note"] == "rollback from v2"
