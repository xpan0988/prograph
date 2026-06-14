pub struct TransferService;
pub struct OtherService;
pub struct TraitOnlyService;

impl TransferService {
    pub fn new() -> Self {
        Self
    }

    pub fn send(&self) {}

    pub fn current_impl_call(&self) {
        self.send();
        Self::new();
    }
}

impl OtherService {
    pub fn send(&self) {}
}

pub trait Sender {
    fn send(&self);
}

impl Sender for TraitOnlyService {
    fn send(&self) {}
}
