---
name: ste-explainer
description: Explain technical work using approximately 80% ASD-STE100 Simplified Technical English. Use when explaining code, architecture, plans, reviews, decisions, or agent output. Optimize for clarity, precision, low ambiguity, and easy human verification.
user-invocable: true
disable-model-invocation: false
---

# STE Explainer

## Purpose

Write technical explanations that a human can understand quickly and verify easily.

Use approximately 80% of the communication principles behind ASD-STE100 Simplified Technical English.

Do not claim formal ASD-STE100 compliance unless the official ASD-STE100 standard and its controlled dictionary are available and the output is checked against them.

The goal is not to make language childish.

The goal is to make technical meaning explicit.

## Core Rule

Prefer:

> One idea. One sentence. One clear action.

Use simple words when they preserve technical meaning.

Keep domain-specific technical terms when they are necessary.

Never replace a precise technical term only because a simpler synonym exists.

## Writing Rules

### 1. Use short sentences

Prefer one main idea per sentence.

Avoid sentences that contain several independent decisions, causes, and consequences.

Bad:

> The service retries failed requests through the queue while also updating the cache, which can create inconsistent state if the consumer crashes after the database write but before the acknowledgement.

Better:

> The service sends failed requests to the queue.

> The consumer writes the result to the database.

> The consumer then sends the acknowledgement.

> A crash between these two steps can leave the message in the queue and the database already updated.

### 2. Prefer concrete verbs

Prefer:

- use
- start
- stop
- read
- write
- create
- delete
- send
- receive
- store
- check
- compare
- return
- fail
- retry
- wait
- verify

Avoid abstract constructions when a direct verb works.

Prefer:

> The service checks the token.

Not:

> Token validation is performed by the service.

### 3. Avoid unnecessary synonyms

Use the same term for the same thing.

Do not alternate between:

- request
- call
- invocation
- operation

unless they represent different concepts.

Choose the correct term and keep using it.

### 4. Make actors explicit

Name who performs an action.

Prefer:

> The API validates the token.

Avoid:

> The token is validated.

Prefer:

> The worker writes the result to PostgreSQL.

Avoid:

> The result is written to PostgreSQL.

Use passive voice only when the actor is unknown or does not matter.

### 5. Make cause and effect explicit

Prefer:

> The cache entry expires.

> The next request misses the cache.

> The service reads from the database.

Avoid vague phrases such as:

> This can potentially lead to issues downstream.

State the actual effect.

### 6. Avoid vague pronouns

Do not use:

- this
- that
- it
- they
- them

when the referenced object could be unclear.

Prefer:

> The retry policy causes duplicate requests.

Not:

> This causes duplicate requests.

### 7. Define terms before using them heavily

When a term may be unfamiliar, define it once.

Format:

> **Idempotent operation** means that repeating the operation produces the same final state.

Then use:

> The retry operation must be idempotent.

### 8. Separate facts from inference

Label the type of claim when useful.

Use:

- **Observed**
- **Inferred**
- **Assumption**
- **Recommendation**
- **Unknown**

Never present an inference as a verified fact.

Example:

> **Observed:** The API returns `504` after 30 seconds.

> **Inferred:** The upstream request may be timing out.

> **Recommendation:** Measure the upstream request duration before changing the timeout.

### 9. Prefer explicit conditions

Use:

> If the token is expired, return `401`.

Not:

> Expired tokens should generally be handled appropriately.

### 10. Prefer ordered procedures

When describing execution, use numbered steps.

```text
1. Read the request.
2. Validate the token.
3. Load the user.
4. Execute the operation.
5. Store the result.
6. Return the response.
```
