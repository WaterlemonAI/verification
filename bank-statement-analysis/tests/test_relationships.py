from bsa.relationships import resolve_accounts


def test_relationship_states_require_distinct_evidence():
    accounts = [
        {"accountId": "a", "ownershipType": "sole", "owners": [{"nameNormalized": "same person"}]},
        {"accountId": "b", "ownershipType": "sole", "owners": [{"nameNormalized": "same person"}]},
        {"accountId": "c", "ownershipType": "joint", "owners": [{"nameNormalized": "same person"}]},
        {"accountId": "d", "ownershipType": "sole", "owners": [{"nameNormalized": "other person"}]},
    ]
    pair = lambda a, b: next(item for item in results if item["accountIds"] == [a, b])
    results = resolve_accounts(accounts, [])
    assert pair("a", "b")["relationship"] == "possible_self_owned"
    assert pair("a", "d")["relationship"] == "unknown"
    transfers = [{"fromAccountId": "a", "toAccountId": "b", "transactionIds": ["debit", "credit"]}]
    results = resolve_accounts(accounts, transfers)
    assert pair("a", "b")["relationship"] == "probable_self_owned"
    assert pair("a", "b")["evidenceTransactionIds"] == ["credit", "debit"]
    assert pair("a", "c")["relationship"] == "possible_self_owned"
    results = resolve_accounts(accounts, transfers,
                               verified_pairs={frozenset(("a", "c"))},
                               third_party_pairs={frozenset(("a", "d"))})
    assert pair("a", "c")["relationship"] == "confirmed_self_owned"
    assert pair("a", "d")["relationship"] == "third_party"
