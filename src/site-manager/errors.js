'use strict';

/**
 * A deliberate refusal with the HTTP status to answer. Anything thrown without a status is an
 * unexpected failure and is answered with a 5xx, which the WordPress connector reads as
 * "outcome unknown" (it keeps its pending credential) rather than as a refusal (it clears it).
 */
class PairingError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

class PairingConflictError extends PairingError {
  constructor(message) {
    super(message, 409);
  }
}

module.exports = { PairingError, PairingConflictError };
