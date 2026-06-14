use crate::{
    diagnostics::quality_label,
    models::{default_micro_flow_group_mode, Mode},
};

pub struct Mode;

pub fn load_or_create() {
    default_micro_flow_group_mode();
    quality_label();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn received_inbox_persistence_defaults_to_enabled() { load_or_create(); }
    fn received_inbox_persistence_roundtrips() { load_or_create(); }
    fn transfer_window_update_is_persisted_when_dev_tools_are_enabled() { load_or_create(); }
    fn dev_tools_toggle_is_persisted() { load_or_create(); }
    fn micro_flow_group_mode_persists_and_invalid_values_fall_back_to_dynamic() { load_or_create(); }
}
