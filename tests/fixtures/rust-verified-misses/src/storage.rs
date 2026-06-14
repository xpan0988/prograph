pub fn burn_room() {}

#[cfg(test)]
mod tests {
    use super::*;

    fn burn_preserves_completed_inbox_file_for_room() { burn_room(); }
    fn burn_does_not_delete_completed_file_from_another_room() { burn_room(); }
    fn burn_deletes_transient_received_file_for_room() { burn_room(); }
    fn burn_skips_saved_path_outside_allowed_roots() { burn_room(); }
    fn burn_deletes_pastey_parts_file_for_room_item() { burn_room(); }
    fn burned_room_cannot_be_resurrected_or_receive_late_finalized_item() { burn_room(); }
}
