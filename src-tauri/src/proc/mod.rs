//! Process launching, inspection, and scheduled closing.

pub mod close;
pub mod commands;
pub mod guard;
pub mod overlay;
pub mod paths;
pub mod session;
pub mod state;

pub use state::ProcState;
