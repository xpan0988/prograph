pub fn validate_control_event() {}

#[cfg(test)]
mod tests {
    use super::*;

    fn replay_checks_event_preview_envelope_and_request_ids() { validate_control_event(); }
}
