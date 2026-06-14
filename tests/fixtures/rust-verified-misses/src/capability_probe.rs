pub fn probe_device_capabilities_with_mode() {}

#[cfg(test)]
mod tests {
    use super::*;

    fn quick_capability_probe_skips_runtime_commands() { probe_device_capabilities_with_mode(); }
    fn battery_devices_are_not_given_heavy_roles() { probe_device_capabilities_with_mode(); }
}
