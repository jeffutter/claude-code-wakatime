import adm_zip from 'adm-zip';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { URL } from 'url';
import * as semver from 'semver';
import * as which from 'which';

import { Options, Setting } from './options';
import { Logger } from './logger';
import { buildOptions, isWindows } from './utils';

enum osName {
  darwin = 'darwin',
  windows = 'windows',
  linux = 'linux',
}

export class Dependencies {
  private options: Options;
  private logger: Logger;
  private resourcesLocation: string;
  private cliLocation?: string = undefined;
  private cliLocationGlobal?: string = undefined;
  private cliInstalled: boolean = false;
  private githubDownloadUrl = 'https://github.com/wakatime/wakatime-cli/releases/latest/download';
  private githubReleasesUrl = 'https://api.github.com/repos/wakatime/wakatime-cli/releases/latest';
  private legacyOperatingSystems: {
    [key in osName]?: {
      kernelLessThan: string;
      tag: string;
    }[];
  } = {
    [osName.darwin]: [{ kernelLessThan: '17.0.0', tag: 'v1.39.1-alpha.1' }],
  };

  constructor(options: Options, logger: Logger) {
    this.options = options;
    this.logger = logger;
    this.resourcesLocation = options.resourcesLocation;
  }

  public getCliLocation(): string {
    if (this.cliLocation) return this.cliLocation;

    this.cliLocation = this.getCliLocationGlobal();
    if (this.cliLocation) return this.cliLocation;

    const osname = this.osName();
    const arch = this.architecture();
    const ext = isWindows() ? '.exe' : '';
    const binary = `wakatime-cli-${osname}-${arch}${ext}`;
    this.cliLocation = path.join(this.resourcesLocation, binary);

    return this.cliLocation;
  }

  public getCliLocationGlobal(): string | undefined {
    if (this.cliLocationGlobal) return this.cliLocationGlobal;

    const binaryName = `wakatime-cli${isWindows() ? '.exe' : ''}`;
    const path = which.sync(binaryName, { nothrow: true });
    if (path) {
      this.cliLocationGlobal = path;
      this.logger.debug(`Using global wakatime-cli location: ${path}`);
    }

    return this.cliLocationGlobal;
  }

  public isCliInstalled(): boolean {
    if (this.cliInstalled) return true;
    this.cliInstalled = fs.existsSync(this.getCliLocation());
    return this.cliInstalled;
  }

  public checkAndInstallCli(callback?: () => void): void {
    if (!this.isCliInstalled()) {
      this.installCli(callback ?? (() => {}));
    } else {
      this.isCliLatest((isLatest) => {
        if (!isLatest) {
          this.installCli(callback ?? (() => {}));
        } else {
          callback?.();
        }
      });
    }
  }

  private isCliLatest(callback: (arg0: boolean) => void): void {
    if (this.getCliLocationGlobal()) {
      callback(true);
      return;
    }

    let args = ['--version'];
    const options = buildOptions();
    try {
      child_process.execFile(this.getCliLocation(), args, options, (error, _stdout, stderr) => {
        if (!error) {
          let currentVersion = _stdout.toString().trim() + stderr.toString().trim();
          this.logger.debug(`Current wakatime-cli version is ${currentVersion}`);

          if (currentVersion === '<local-build>') {
            callback(true);
            return;
          }

          const tag = this.legacyReleaseTag();
          if (tag && currentVersion !== tag) {
            callback(false);
            return;
          }

          const accessed = this.options.getSetting('internal', 'cli_version_last_accessed', true);
          const now = Math.round(Date.now() / 1000);
          const lastAccessed = parseInt(accessed ?? '0');
          const fourHours = 4 * 3600;
          if (lastAccessed && lastAccessed + fourHours > now) {
            this.logger.debug(`Skip checking for wakatime-cli updates because recently checked ${now - lastAccessed} seconds ago.`);
            callback(true);
            return;
          }

          this.logger.debug('Checking for updates to wakatime-cli...');
          this.getLatestCliVersion((latestVersion) => {
            if (currentVersion === latestVersion) {
              this.logger.debug('wakatime-cli is up to date');
              callback(true);
            } else if (latestVersion) {
              this.logger.debug(`Found an updated wakatime-cli ${latestVersion}`);
              callback(false);
            } else {
              this.logger.debug('Unable to find latest wakatime-cli version');
              callback(false);
            }
          });
        } else {
          callback(false);
        }
      });
    } catch (e) {
      callback(false);
    }
  }

  private getLatestCliVersion(callback: (arg0: string) => void): void {
    const proxy = this.options.getSetting('settings', 'proxy');
    const noSSLVerify = this.options.getSetting('settings', 'no_ssl_verify');
    const url = new URL(this.githubReleasesUrl);

    const requestOptions: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'User-Agent': 'github.com/wakatime/claude-code-wakatime',
      },
      rejectUnauthorized: noSSLVerify !== 'true',
    };

    this.logger.debug(`Fetching latest wakatime-cli version from GitHub API: ${this.githubReleasesUrl}`);
    if (proxy) {
      this.logger.debug(`Using Proxy: ${proxy}`);
      // Note: Proxy support would require additional implementation with http-proxy-agent
      this.logger.warn('Proxy support with native https module requires additional setup');
    }

    try {
      const req = https.get(requestOptions, (response) => {
        let data = '';

        response.on('data', (chunk) => {
          data += chunk;
        });

        response.on('end', () => {
          if (response.statusCode === 200) {
            try {
              this.logger.debug(`GitHub API Response ${response.statusCode}`);
              const json = JSON.parse(data);
              const latestCliVersion = json['tag_name'];
              this.logger.debug(`Latest wakatime-cli version from GitHub: ${latestCliVersion}`);
              this.options.setSetting('internal', 'cli_version_last_accessed', String(Math.round(Date.now() / 1000)), true);
              callback(latestCliVersion);
            } catch (e) {
              this.logger.warn(`Failed to parse GitHub API response: ${e}`);
              callback('');
            }
          } else {
            this.logger.warn(`GitHub API Response ${response.statusCode}`);
            callback('');
          }
        });
      });

      req.on('error', (error) => {
        this.logger.warn(`GitHub API Response Error: ${error}`);
        callback('');
      });

      req.end();
    } catch (e) {
      this.logger.warnException(e);
      callback('');
    }
  }

  private installCli(callback: () => void): void {
    this.logger.debug(`Downloading wakatime-cli from GitHub...`);
    const url = this.cliDownloadUrl();
    let zipFile = path.join(this.resourcesLocation, 'wakatime-cli' + this.randStr() + '.zip');
    this.downloadFile(
      url,
      zipFile,
      () => {
        this.extractCli(zipFile, callback);
      },
      callback,
    );
  }

  private isSymlink(file: string): boolean {
    try {
      return fs.lstatSync(file).isSymbolicLink();
    } catch (_) {}
    return false;
  }

  private extractCli(zipFile: string, callback: () => void): void {
    this.logger.debug(`Extracting wakatime-cli into "${this.resourcesLocation}"...`);
    this.backupCli();
    this.unzip(zipFile, this.resourcesLocation, (unzipped) => {
      if (!unzipped) {
        this.restoreCli();
      } else if (!isWindows()) {
        this.removeCli();
        const cli = this.getCliLocation();
        try {
          this.logger.debug('Chmod 755 wakatime-cli...');
          fs.chmodSync(cli, 0o755);
        } catch (e) {
          this.logger.warnException(e);
        }
        const ext = isWindows() ? '.exe' : '';
        const link = path.join(this.resourcesLocation, `wakatime-cli${ext}`);
        if (!this.isSymlink(link)) {
          try {
            this.logger.debug(`Create symlink from wakatime-cli to ${cli}`);
            fs.symlinkSync(cli, link);
          } catch (e) {
            this.logger.warnException(e);
            try {
              fs.copyFileSync(cli, link);
              fs.chmodSync(link, 0o755);
            } catch (e2) {
              this.logger.warnException(e2);
            }
          }
        }
      }
      callback();
    });
    this.logger.debug('Finished extracting wakatime-cli.');
  }

  private backupCli() {
    if (fs.existsSync(this.getCliLocation())) {
      fs.renameSync(this.getCliLocation(), `${this.getCliLocation()}.backup`);
    }
  }

  private restoreCli() {
    const backup = `${this.getCliLocation()}.backup`;
    if (fs.existsSync(backup)) {
      fs.renameSync(backup, this.getCliLocation());
    }
  }

  private removeCli() {
    const backup = `${this.getCliLocation()}.backup`;
    if (fs.existsSync(backup)) {
      fs.unlinkSync(backup);
    }
  }

  private downloadFile(url: string, outputFile: string, callback: () => void, error: () => void): void {
    const proxy = this.options.getSetting('settings', 'proxy');
    const noSSLVerify = this.options.getSetting('settings', 'no_ssl_verify');

    if (proxy) {
      this.logger.debug(`Using Proxy: ${proxy}`);
      this.logger.warn('Proxy support with native https module requires additional setup');
    }

    const download = (downloadUrl: string, redirectCount: number = 0): void => {
      if (redirectCount > 5) {
        this.logger.warn(`Too many redirects for ${url}`);
        error();
        return;
      }

      try {
        const urlObj = new URL(downloadUrl);
        const protocol = urlObj.protocol === 'https:' ? https : http;

        const requestOptions: https.RequestOptions = {
          hostname: urlObj.hostname,
          port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
          path: urlObj.pathname + urlObj.search,
          method: 'GET',
          rejectUnauthorized: noSSLVerify !== 'true',
        };

        const req = protocol.get(requestOptions, (response) => {
          // Handle redirects
          if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            this.logger.debug(`Following redirect to ${response.headers.location}`);
            download(response.headers.location, redirectCount + 1);
            return;
          }

          if (response.statusCode !== 200) {
            this.logger.warn(`Failed to download ${downloadUrl}: HTTP ${response.statusCode}`);
            error();
            return;
          }

          const out = fs.createWriteStream(outputFile);

          response.pipe(out);

          out.on('finish', () => {
            callback();
          });

          out.on('error', (e) => {
            this.logger.warn(`Failed to write file ${outputFile}`);
            this.logger.warn(e.toString());
            error();
          });
        });

        req.on('error', (e) => {
          this.logger.warn(`Failed to download ${downloadUrl}`);
          this.logger.warn(e.toString());
          error();
        });

        req.end();
      } catch (e) {
        this.logger.warnException(e);
        error();
      }
    };

    download(url);
  }

  private unzip(file: string, outputDir: string, callback: (unzipped: boolean) => void): void {
    if (fs.existsSync(file)) {
      try {
        let zip = new adm_zip(file);
        zip.extractAllTo(outputDir, true);
        fs.unlinkSync(file);
        callback(true);
        return;
      } catch (e) {
        this.logger.warnException(e);
      }
      try {
        fs.unlinkSync(file);
      } catch (e2) {
        this.logger.warnException(e2);
      }
      callback(false);
    }
  }

  private legacyReleaseTag() {
    const osname = this.osName() as osName;
    const legacyOS = this.legacyOperatingSystems[osname];
    if (!legacyOS) return;
    const version = legacyOS.find((spec) => {
      try {
        return semver.lt(os.release(), spec.kernelLessThan);
      } catch (e) {
        return false;
      }
    });
    return version?.tag;
  }

  private architecture(): string {
    const arch = os.arch();
    if (arch.indexOf('32') > -1) return '386';
    if (arch.indexOf('x64') > -1) return 'amd64';
    return arch;
  }

  private osName(): string {
    let osname = os.platform() as string;
    if (osname == 'win32') osname = 'windows';
    return osname;
  }

  private cliDownloadUrl(): string {
    const osname = this.osName();
    const arch = this.architecture();

    // Use legacy wakatime-cli release to support older operating systems
    const tag = this.legacyReleaseTag();
    if (tag) {
      return `https://github.com/wakatime/wakatime-cli/releases/download/${tag}/wakatime-cli-${osname}-${arch}.zip`;
    }

    const validCombinations = [
      'android-amd64',
      'android-arm64',
      'darwin-amd64',
      'darwin-arm64',
      'freebsd-386',
      'freebsd-amd64',
      'freebsd-arm',
      'linux-386',
      'linux-amd64',
      'linux-arm',
      'linux-arm64',
      'netbsd-386',
      'netbsd-amd64',
      'netbsd-arm',
      'openbsd-386',
      'openbsd-amd64',
      'openbsd-arm',
      'openbsd-arm64',
      'windows-386',
      'windows-amd64',
      'windows-arm64',
    ];
    if (!validCombinations.includes(`${osname}-${arch}`)) this.reportMissingPlatformSupport(osname, arch);

    return `${this.githubDownloadUrl}/wakatime-cli-${osname}-${arch}.zip`;
  }

  private reportMissingPlatformSupport(osname: string, architecture: string): void {
    const urlString = `https://api.wakatime.com/api/v1/cli-missing?osname=${osname}&architecture=${architecture}&plugin=claude-code`;
    const proxy = this.options.getSetting('settings', 'proxy');
    const noSSLVerify = this.options.getSetting('settings', 'no_ssl_verify');

    try {
      const url = new URL(urlString);
      const requestOptions: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'GET',
        rejectUnauthorized: noSSLVerify !== 'true',
      };

      if (proxy) {
        this.logger.debug(`Using Proxy: ${proxy}`);
      }

      const req = https.get(requestOptions);
      req.on('error', () => {
        // Silently ignore errors for this fire-and-forget request
      });
      req.end();
    } catch (e) {
      // Silently ignore errors
    }
  }

  private randStr(): string {
    return (Math.random() + 1).toString(36).substring(7);
  }
}
