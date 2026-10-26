"""Evidence-scored account relationships; names alone never confirm ownership."""

from itertools import combinations


VERSION = "account-relationship-v1.0.0"


def resolve_accounts(accounts: list[dict], transfers: list[dict], *,
                     verified_pairs: set[frozenset[str]] | None = None,
                     third_party_pairs: set[frozenset[str]] | None = None) -> list[dict]:
    verified_pairs = verified_pairs or set()
    third_party_pairs = third_party_pairs or set()
    results = []
    for first, second in combinations(sorted(accounts, key=lambda item: item["accountId"]), 2):
        pair = frozenset((first["accountId"], second["accountId"]))
        matching = [item for item in transfers if
                    frozenset((item["fromAccountId"], item["toAccountId"])) == pair]
        first_names = {owner["nameNormalized"] for owner in first["owners"] if owner["nameNormalized"]}
        second_names = {owner["nameNormalized"] for owner in second["owners"] if owner["nameNormalized"]}
        same_name = bool(first_names & second_names)
        evidence_ids = sorted({id for item in matching for id in item["transactionIds"]})
        if pair in verified_pairs:
            relationship, confidence, reason = "confirmed_self_owned", 1.0, "EXTERNALLY_VERIFIED_ACCOUNT_PAIR"
        elif pair in third_party_pairs:
            relationship, confidence, reason = "third_party", 1.0, "EXTERNALLY_VERIFIED_THIRD_PARTY"
        elif matching and same_name and first["ownershipType"] == second["ownershipType"] == "sole":
            relationship, confidence, reason = "probable_self_owned", 0.9, "PAIRED_TRANSFER_AND_NAME"
        elif same_name:
            relationship, confidence, reason = "possible_self_owned", 0.5, "HOLDER_NAME_OVERLAP_ONLY"
        else:
            relationship, confidence, reason = "unknown", 0.0, "INSUFFICIENT_RELATIONSHIP_EVIDENCE"
        results.append({"accountIds": sorted(pair), "relationship": relationship,
                        "confidence": confidence, "reasonCode": reason,
                        "evidenceTransactionIds": evidence_ids,
                        "methodVersion": VERSION})
    return results
