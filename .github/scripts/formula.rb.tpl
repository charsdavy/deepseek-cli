class Deepseek < Formula
  desc "Agentic command-line AI coding assistant powered by DeepSeek"
  homepage "https://github.com/charsdavy/deepseek-cli"
  version "{{VERSION}}"
  license "MIT"
  head "https://github.com/charsdavy/deepseek-cli.git", branch: "main"

  # Livecheck: probe the GitHub releases for the latest tag.
  livecheck do
    url :stable
    strategy :github_latest
  end

  on_macos do
    on_arm do
      url "{{RELEASE_URL}}/{{TAG}}/deepseek-v{{VERSION}}-darwin-arm64.tar.gz"
      sha256 "{{SHA_DARWIN_ARM64}}"
    end
    on_intel do
      url "{{RELEASE_URL}}/{{TAG}}/deepseek-v{{VERSION}}-darwin-x64.tar.gz"
      sha256 "{{SHA_DARWIN_X64}}"
    end
  end

  on_linux do
    on_arm do
      url "{{RELEASE_URL}}/{{TAG}}/deepseek-v{{VERSION}}-linux-arm64.tar.gz"
      sha256 "{{SHA_LINUX_ARM64}}"
    end
    on_intel do
      url "{{RELEASE_URL}}/{{TAG}}/deepseek-v{{VERSION}}-linux-x64.tar.gz"
      sha256 "{{SHA_LINUX_X64}}"
    end
  end

  # Each tarball unpacks a single `deepseek` binary (Bun --compile output,
  # 60–80 MB self-contained). Rename-less bin.install keeps things simple.
  def install
    bin.install "deepseek"
  end

  def caveats
    <<~EOS
      Run `deepseek auth` once to configure your DeepSeek API key.
      Then `deepseek` starts an interactive agentic session.
    EOS
  end

  test do
    assert_match "deepseek #{version}", shell_output("#{bin}/deepseek --version")
  end
end
