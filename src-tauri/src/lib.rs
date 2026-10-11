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

/// Value of `--name value` on the command line.
fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

/// Script run before the page: `--seed --hour --quality --camera x,z,yaw,pitch,distance` seed the page's saved settings, and
/// `--screenshot path [--shot-delay seconds]` asks it to save a frame once the map is built (see main.ts `captureRequested`).
fn startup_script() -> String {
    let mut patch = Vec::new();
    if let Some(v) = arg("--seed").and_then(|v| v.parse::<f64>().ok()) {
        patch.push(format!("seed:{v}"));
    }
    if let Some(v) = arg("--hour").and_then(|v| v.parse::<f64>().ok()) {
        patch.push(format!("hour:{v}"));
    }
    if let Some(v) = arg("--quality").filter(|v| v.chars().all(|c| c.is_ascii_alphanumeric())) {
        patch.push(format!("quality:\"{v}\""));
    }
    if let Some(v) = arg("--camera") {
        let n: Vec<f64> = v.split(',').filter_map(|s| s.trim().parse().ok()).collect();
        if n.len() == 5 {
            patch.push(format!("camera:{{x:{},z:{},yaw:{},pitch:{},distance:{}}}", n[0], n[1], n[2], n[3], n[4]));
        }
    }
    let mut script = String::new();
    if !patch.is_empty() {
        script += &format!(
            "try{{localStorage.setItem('wargame.settings',JSON.stringify(Object.assign(JSON.parse(localStorage.getItem('wargame.settings')||'{{}}'),{{{}}})))}}catch(e){{}};",
            patch.join(",")
        );
    }
    if let Some(path) = arg("--screenshot") {
        let delay = arg("--shot-delay").and_then(|v| v.parse::<f64>().ok()).unwrap_or(6.0);
        let profile = arg("--shot-profile").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
        script += &format!("window.__SHOT={{path:{:?},delay:{delay},profile:{profile}}};", path);
    }
    script
}

/// Writes the PNG data URL handed over by the page (command line screenshot) and quits.
#[tauri::command]
fn save_screenshot(app: tauri::AppHandle, path: String, data_url: String, text: String) -> Result<(), String> {
    let b64 = data_url.split_once(',').map(|(_, b)| b).ok_or("bad data url")?;
    std::fs::write(&path, decode_base64(b64)?).map_err(|e| e.to_string())?;
    std::fs::write(format!("{path}.txt"), text).map_err(|e| e.to_string())?; // the panel text (fps, draw calls...)
    app.exit(0);
    Ok(())
}

fn decode_base64(s: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\n' | b'\r' => continue,
            _ => return Err("bad base64".into()),
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    prefer_discrete_gpu();

    let script = startup_script();
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![save_screenshot])
        .setup(move |app| {
            // The window (tauri.conf.json, `create: false`) is made here so the command line script runs before the page.
            let config = app.config().app.windows[0].clone();
            tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                .initialization_script(script.clone())
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
