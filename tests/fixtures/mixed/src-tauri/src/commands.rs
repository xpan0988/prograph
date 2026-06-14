pub struct Greeting {
    pub value: String,
}

pub enum GreetingKind {
    Friendly,
}

pub trait RenderGreeting {
    fn render(&self) -> String;
}

fn decorate(name: &str) -> String {
    format!("Hello {name}")
}

#[tauri::command]
pub fn greet(name: &str) -> String {
    decorate(name)
}
