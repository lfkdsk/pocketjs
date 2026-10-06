//! `--headless`: run the runtime worker's tick loop on the main thread with
//! no window, for automated runs (network conformance, CI without a
//! display). Guest console output goes to the log as in windowed mode.
//! `--screenshot PATH` renders the final frame through an offscreen GPU
//! device and writes it as PNG.
use super::*;
use pocket3d::gpu::Gpu;

pub struct Options {
    screenshot: Option<PathBuf>,
}

/// `Some` when `--headless` is on the command line.
pub fn options() -> Option<Options> {
    let argv: Vec<String> = std::env::args().collect();
    if !argv.iter().any(|a| a == "--headless") {
        return None;
    }
    let screenshot = argv
        .iter()
        .position(|a| a == "--screenshot")
        .and_then(|i| argv.get(i + 1))
        .map(PathBuf::from);
    Some(Options { screenshot })
}

pub fn run(args: Args, options: Options) -> Result<()> {
    let mut runtime = Runtime::boot(args)?;
    let mut deadline = Instant::now();
    loop {
        let work = Instant::now();
        let intents = runtime.tick()?;
        trace_frame(runtime.args.trace_frames, "tick", runtime.ticks, work);
        if intents.iter().any(|v| v["t"] == "quit") {
            break;
        }
        if runtime
            .args
            .quit_after_ticks
            .is_some_and(|n| runtime.ticks >= n)
        {
            break;
        }
        deadline += TICK;
        let budget = IdleBudget {
            remaining: deadline.saturating_duration_since(Instant::now()),
            period: TICK,
        };
        runtime.guest.idle_gc(Some(budget));
        match deadline.checked_duration_since(Instant::now()) {
            Some(wait) => thread::sleep(wait),
            None => deadline = Instant::now(),
        }
    }
    if let Some(path) = options.screenshot {
        screenshot(&mut runtime, &path)?;
        log::info!("pocket-desktop-host: wrote {}", path.display());
    }
    Ok(())
}

fn screenshot(runtime: &mut Runtime, path: &std::path::Path) -> Result<()> {
    let gpu = Arc::new(Gpu::new_headless()?);
    let mut renderer = gpu::Renderer::new(gpu.clone());
    let target = renderer
        .render(runtime)?
        .ok_or_else(|| anyhow!("no render target available"))?;
    let (width, height) = target.size;
    let row = width * 4;
    let stride =
        row.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Pocket headless readback"),
        size: u64::from(stride * height),
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut encoder = gpu
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Pocket headless readback"),
        });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &target._texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(stride),
                rows_per_image: Some(height),
            },
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );
    gpu.queue.submit([encoder.finish()]);
    let slice = buffer.slice(..);
    slice.map_async(wgpu::MapMode::Read, |_| {});
    gpu.device
        .poll(wgpu::PollType::Wait)
        .map_err(|e| anyhow!("GPU readback: {e}"))?;
    let mapped = slice.get_mapped_range();
    let mut pixels = Vec::with_capacity((row * height) as usize);
    for y in 0..height {
        let start = (y * stride) as usize;
        pixels.extend_from_slice(&mapped[start..start + row as usize]);
    }
    drop(mapped);
    buffer.unmap();
    let file = std::io::BufWriter::new(std::fs::File::create(path)?);
    let mut encoder = png::Encoder::new(file, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header()?.write_image_data(&pixels)?;
    Ok(())
}
