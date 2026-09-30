unsafe extern "C" { fn run(value: i32) -> i32; }
pub fn load() -> i32 { unsafe { run(1) } }
