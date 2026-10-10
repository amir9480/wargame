/// Makes WebView2 (Chromium) pick the discrete GPU on hybrid-graphics laptops. Must be set before the webview starts.
#[cfg(windows)]
fn prefer_discrete_gpu() {
    const FLAGS: &str = "--force_high_performance_gpu";
    let args = match std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        Ok(existing) if !existing.is_empty() => format!("{existing} {FLAGS}"),
        _ => FLAGS.to_string(),
    };
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    prefer_discrete_gpu();

    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
