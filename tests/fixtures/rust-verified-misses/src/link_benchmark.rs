use crate::{
    diagnostics::{quality_label, LinkQuality},
    models::default_micro_flow_group_mode,
};

pub struct LinkQuality;

pub fn run_loopback_benchmark() {
    quality_label();
}

pub fn run_peer_link_benchmark() {
    quality_label();
    default_micro_flow_group_mode();
}
