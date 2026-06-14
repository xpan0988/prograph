mod commands;
mod duplicate_a;
mod duplicate_b;
mod events;
mod logging;
mod service;
mod reexports;

use crate::events::TRANSFER_EVENT;
use crate::logging::imported_write;
use crate::service::{OtherService, TraitOnlyService, TransferService};
use crate::{
    logging::{imported_write as nested_imported_write, write_transfer_line as nested_write},
    reexports::reexported_write,
};

pub fn module_calls() {
    logging::write_transfer_line();
    crate::logging::write_transfer_line();
    self::logging::write_transfer_line();
    imported_write();
    nested_imported_write();
    nested_write();
    reexported_write();
    external_crate::external_call();
}

pub fn local_import_user() {
    use crate::logging::imported_write as scoped_write;
    scoped_write();
}

pub fn local_import_sibling() {
    scoped_write();
}

mod child {
    pub fn parent_call() {
        super::logging::write_transfer_line();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calls_parent_function_through_glob() {
        module_calls();
    }
}

pub fn typed_receiver(service: &TransferService, other: &OtherService, trait_only: &TraitOnlyService) {
    service.send();
    other.send();
    trait_only.send();
}

pub fn constructor_receiver() {
    let service = TransferService::new();
    service.send();
}

pub fn ambiguous_duplicate_name() {
    duplicate();
}

pub fn event_calls(app: &tauri::AppHandle, runtime_event: &str) {
    const LOCAL_EVENT: &str = "pastey://local";
    app.emit("pastey://direct", ());
    app.emit(LOCAL_EVENT, ());
    app.emit(TRANSFER_EVENT, ());
    app.emit(events::ALIAS_EVENT, ());
    app.emit(runtime_event, ());
}

pub fn registrations() {
    let _ = tauri::generate_handler![
        commands::real_command,
        commands::command_one,
    ];
    let _ = tauri::generate_handler![commands::single_line_command];
}
