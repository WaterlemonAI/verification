from decimal import Decimal, InvalidOperation
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class Money(BaseModel):
    value: str
    currency: str
    scale: int

    @field_validator("scale")
    @classmethod
    def valid_scale(cls, value: int) -> int:
        if not 0 <= value <= 3:
            raise ValueError("invalid currency scale")
        return value

    @field_validator("value")
    @classmethod
    def decimal_string(cls, value: str) -> str:
        try:
            number = Decimal(value)
        except InvalidOperation as error:
            raise ValueError("invalid decimal") from error
        if not number.is_finite() or str(value).lower() in {"nan", "inf", "infinity"}:
            raise ValueError("invalid decimal")
        return value

    @field_validator("currency")
    @classmethod
    def currency_code(cls, value: str) -> str:
        if len(value) != 3 or not value.isalpha() or value.upper() != value:
            raise ValueError("invalid currency")
        return value


class Evidence(BaseModel):
    documentId: str
    statementSegmentId: str
    page: int
    rawText: str
    extractionMethod: str = "pypdf-native-v1"
    extractionConfidence: float = 1.0
    boundingBox: list[float] | None = None
    boundingPolygon: list[list[float]] | None = None
    extractorVersion: str | None = None
    normalizationVersion: str | None = None


class Owner(BaseModel):
    ownerId: str
    nameRaw: str
    nameNormalized: str
    role: Literal["owner", "joint_owner", "primary_owner", "authorized_signatory", "supplementary_cardholder", "unknown"]
    attributionConfidence: float
    evidence: list[Evidence] = Field(default_factory=list)


class Account(BaseModel):
    accountId: str
    bankId: str
    accountNumberMasked: str
    accountFingerprint: str
    productType: str
    ledgerNature: Literal["asset", "liability"]
    ownershipType: Literal["sole", "joint", "unknown"]
    owners: list[Owner] = Field(default_factory=list)
    ledgerCurrencies: list[str]
    ibanMasked: str | None = None


class Balance(BaseModel):
    balanceId: str
    type: Literal["opening_booked", "closing_booked", "current", "available", "interim", "forward_available", "overdraft_limit", "credit_limit", "unknown"]
    amount: Money
    creditDebitIndicator: Literal["CREDIT", "DEBIT"]
    canonicalSignedValue: str
    asOf: str
    sourceLabel: str
    evidence: list[Evidence] = Field(default_factory=list)


class Facility(BaseModel):
    facilityType: Literal["overdraft", "credit_card", "loan"]
    accountId: str
    limit: Money | None = None
    utilized: Money | None = None
    available: Money | None = None
    calculationMethod: str
    evidence: list[Evidence] = Field(default_factory=list)


class Transaction(BaseModel):
    transactionId: str
    accountId: str
    ledgerCurrency: str
    bookingDate: str
    creditDebitIndicator: Literal["CREDIT", "DEBIT"]
    ledgerAmount: Money
    runningBalance: Money
    referenceRaw: str
    descriptionRaw: str
    counterpartyRaw: str
    evidence: list[Evidence]
    valueDate: str | None = None
    descriptionNormalized: str | None = None
    originalAmount: Money | None = None
    exchangeRate: str | None = None
    bankTransactionCodeRaw: str | None = None
    counterpartyId: str | None = None
    economicClassification: dict | None = None


class Segment(BaseModel):
    statementSegmentId: str
    bankId: str
    accountId: str
    accountFingerprint: str | None = None
    accountNumberMasked: str
    productType: str
    ledgerNature: Literal["asset", "liability"]
    ownershipType: Literal["sole", "joint", "unknown"]
    ownerName: str
    currency: str
    periodStart: str
    periodEnd: str
    openingBalance: Money
    closingBalance: Money
    transactions: list[Transaction]
    pages: list[int]
    reconciliation: dict
    bankProfileVersion: str | None = None
    reportedFacilityLimit: Money | None = None
    openingEvidence: list[Evidence] = Field(default_factory=list)
    closingEvidence: list[Evidence] = Field(default_factory=list)
    facilityEvidence: list[Evidence] = Field(default_factory=list)
