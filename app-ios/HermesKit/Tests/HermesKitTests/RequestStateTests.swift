import Testing
@testable import HermesKit

@Test func unresolvedReceiptCreateRetainsBodyPayerAndKey() {
    var write = PendingWrite<CreateTransactionBody>()
    let original = CreateTransactionBody(date: "2026-03-10", amountCents: -500, payee: "Synthetic Quill",
                                         categoryId: nil, notes: nil, paidByPersonId: "p1", inboxReceiptId: "r1")
    let changed = CreateTransactionBody(date: "2026-03-11", amountCents: -700, payee: "Synthetic Wren",
                                        categoryId: nil, notes: nil, paidByPersonId: "p2", inboxReceiptId: "r2")
    let key = write.guardState.key
    let r1 = write.prepare(original)
    #expect(r1 == original)
    write.guardState.didFail(ClientError.transport("timed out"))
    let r2 = write.prepare(changed)
    #expect(r2 == original)
    #expect(write.body?.paidByPersonId == "p1" && write.guardState.key == key)
    #expect(write.body?.inboxReceiptId == "r1")
    write.guardState.didFail(ClientError.api(status: 401, body: APIErrorBody(code: "UNAUTHORIZED", message: "x")))
    let r3 = write.prepare(changed)
    #expect(r3 == original)
    write.guardState.didSucceed()
    let r4 = write.prepare(changed)
    #expect(r4 == changed && write.guardState.key != key)
}

@Test func unresolvedCancellationRetainsIntentWhenRefreshedItemChanges() {
    var write = PendingWrite<Bool>()
    let r5 = write.prepare(true)
    #expect(r5)
    let key = write.guardState.key
    write.guardState.didFail(ClientError.transport("timed out"))
    let r6 = write.prepare(false)
    #expect(r6)
    #expect(write.guardState.key == key)
    write.guardState.didSucceed()
    let r7 = write.prepare(false)
    #expect(!r7)
    write.guardState.didFail(ClientError.transport("timed out"))
    let r8 = write.prepare(true)
    #expect(!r8)
}

@Test func rejectedWriteAcceptsACorrectedBody() {
    var write = PendingWrite<Bool>()
    let r9 = write.prepare(true)
    #expect(r9)
    write.guardState.didFail(ClientError.api(status: 400, body: APIErrorBody(code: "INVALID_REQUEST", message: "x")))
    let r10 = write.prepare(false)
    #expect(!r10)
}

@Test func slowOpensCannotReplaceNewerOrAlreadyPresentedSheets() {
    var opens = OpenGeneration()
    let first = opens.next()
    let second = opens.next()
    #expect(opens.accepts(second, presented: false))
    #expect(!opens.accepts(first, presented: false))
    #expect(!opens.accepts(second, presented: true))
    _ = opens.next() // leaving the screen invalidates outstanding opens
    #expect(!opens.accepts(second, presented: false))
}

@Test func newSearchCannotUseOldCursorBeforeOrAfterFailedReset() {
    var page = PageCursor<TransactionQuery>()
    let first = TransactionQuery(accountId: "a1", categoryId: "c1", q: "Synthetic Quill", personId: "p1")
    let second = TransactionQuery(accountId: "a2", categoryId: "c2", q: "Synthetic Wren", personId: "p2")
    page.didLoad(first, nextCursor: "first-page")
    let r11 = page.next(for: first)
    #expect(r11 == "first-page")
    let r12 = page.next(for: second)
    #expect(r12 == nil)
    page.reset()
    // A failed first-page request never calls didLoad, even if the user changes back to the old query.
    let r13 = page.next(for: first)
    let r14 = page.next(for: second)
    #expect(r13 == nil && r14 == nil)
    page.didLoad(second, nextCursor: "second-page")
    let r15 = page.next(for: first)
    let r16 = page.next(for: second)
    #expect(r15 == nil && r16 == "second-page")
    page.didLoad(second, nextCursor: nil)
    let r17 = page.next(for: second)
    #expect(r17 == nil)
}

@Test func pickerSearchCannotContinueWithAnotherSearchCursor() {
    var page = PageCursor<String>()
    page.didLoad("Synthetic Quill", nextCursor: "old-page")
    let r18 = page.next(for: "Synthetic Wren")
    #expect(r18 == nil)
    page.reset()
    let r19 = page.next(for: "Synthetic Quill")
    #expect(r19 == nil)
}
