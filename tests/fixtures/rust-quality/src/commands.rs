#[tauri::command]
pub fn real_command() {}

pub fn ordinary_function() {}

#[tauri::command]
pub async fn command_one() {}

const SOME_VALUE: usize = 1;

pub fn command_two() {}

#[tauri::command]
pub fn single_line_command() {}
