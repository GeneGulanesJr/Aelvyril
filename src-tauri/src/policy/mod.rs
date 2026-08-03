//! Content-policy linting: zero-shot rule matching for outbound prompts.
//!
//! The gateway runs the linter on user-role messages (post-PII pseudonymization,
//! pre-forward). `warn` violations are recorded in the audit log and the request
//! continues. `block` violations short-circuit the request with a 400 to the client
//! and are recorded as blocked events.

pub mod linter;

pub use linter::{
    LiquidPolicyClient, LiquidPolicyClientBuilder, PolicyAction, PolicyError, PolicyRule,
    PolicyViolation,
};