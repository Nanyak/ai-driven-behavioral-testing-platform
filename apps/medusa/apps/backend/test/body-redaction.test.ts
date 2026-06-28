import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { MASKED_VALUE, reduceValue } from "../src/api/body-redaction"

describe("body redaction", () => {
  it("masks sensitive scalar fields without changing ordinary values", () => {
    assert.deepEqual(
      reduceValue({
        email: "customer@example.com",
        password: "never-log-this",
        quantity: 2,
        metadata: { source: "test" }
      }),
      {
        email: MASKED_VALUE,
        password: MASKED_VALUE,
        quantity: 2,
        metadata: { source: "test" }
      }
    )
  })

  it("does not mask harmless keys that only resemble sensitive concepts", () => {
    assert.deepEqual(
      reduceValue({
        payment_status: "captured",
        accounting_code: "revenue",
        paper_size: "A4",
        document_type: "invoice",
        card_brand: "visa"
      }),
      {
        payment_status: "captured",
        accounting_code: "revenue",
        paper_size: "A4",
        document_type: "invoice",
        card_brand: "visa"
      }
    )
  })

  it("preserves sensitive container structure while masking every primitive leaf", () => {
    assert.deepEqual(
      reduceValue({
        shipping_address: {
          first_name: "Ada",
          city: "Hanoi",
          postal_code: "100000",
          location: { latitude: 21.0285, verified: true },
          tags: ["home", "primary"],
          nullable: null
        }
      }),
      {
        shipping_address: {
          first_name: MASKED_VALUE,
          city: MASKED_VALUE,
          postal_code: MASKED_VALUE,
          location: { latitude: 0, verified: false },
          tags: [MASKED_VALUE, MASKED_VALUE],
          nullable: null
        }
      }
    )
  })

  it("does not expose values in sensitive arrays, including mixed nested shapes", () => {
    const reduced = reduceValue({
      payment_methods: [
        { provider: "stripe", details: { last4: "4242", reusable: false } },
        "cash"
      ]
    })

    assert.deepEqual(reduced, {
      payment_methods: [
        {
          provider: MASKED_VALUE,
          details: { last4: MASKED_VALUE, reusable: false }
        },
        MASKED_VALUE
      ]
    })
    assert.equal(JSON.stringify(reduced).includes("4242"), false)
    assert.equal(JSON.stringify(reduced).includes("stripe"), false)
  })

  it("uses safe structural markers when depth and collection limits are reached", () => {
    const reduced = reduceValue({
      account: {
        a: {
          b: {
            c: {
              leaked: "must-never-appear"
            }
          }
        },
        documents: Array.from({ length: 12 }, (_, index) => `secret-${index}`)
      }
    })
    const serialized = JSON.stringify(reduced)

    assert.equal(serialized.includes("must-never-appear"), false)
    assert.equal(serialized.includes("secret-"), false)
    assert.deepEqual(reduced, {
      account: {
        a: {
          b: {
            c: "[object]"
          }
        },
        documents: [
          MASKED_VALUE,
          MASKED_VALUE,
          MASKED_VALUE,
          MASKED_VALUE,
          MASKED_VALUE,
          MASKED_VALUE,
          MASKED_VALUE,
          MASKED_VALUE,
          MASKED_VALUE,
          MASKED_VALUE,
          "[2 more items]"
        ]
      }
    })
  })

  it("preserves primitive types below sensitive containers using safe replacements", () => {
    const reduced = reduceValue({
      payment_details: {
        label: "private",
        amount: 123.45,
        reusable: true,
        absent: null
      }
    }) as {
      payment_details: Record<string, unknown>
    }

    assert.equal(typeof reduced.payment_details.label, "string")
    assert.equal(typeof reduced.payment_details.amount, "number")
    assert.equal(typeof reduced.payment_details.reusable, "boolean")
    assert.equal(reduced.payment_details.label, MASKED_VALUE)
    assert.equal(reduced.payment_details.amount, 0)
    assert.equal(reduced.payment_details.reusable, false)
    assert.equal(reduced.payment_details.absent, null)
    assert.equal(JSON.stringify(reduced).includes("123.45"), false)
    assert.equal(JSON.stringify(reduced).includes("private"), false)
  })

  it("retains the explicit raw-capture behavior when masking is disabled", () => {
    assert.deepEqual(reduceValue({ email: "fixture@example.com" }, 0, false), {
      email: "fixture@example.com"
    })
  })
})
