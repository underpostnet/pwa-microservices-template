import { getNpmRootPath } from '../server/conf.js';
import { getLocalIPv4Address } from '../server/dns.js';
import { pbcopy, shellExec } from '../server/process.js';
import fs from 'fs-extra';

class UnderpostLxd {
  static API = {
    async callback(
      options = {
        init: false,
        reset: false,
        dev: false,
        install: false,
        createVirtualNetwork: false,
        control: false,
        worker: false,
        startVm: '',
        initVm: '',
        createVm: '',
        infoVm: '',
        rootSize: '',
        joinNode: '',
        expose: '',
      },
    ) {
      const npmRoot = getNpmRootPath();
      const underpostRoot = options?.dev === true ? '.' : `${npmRoot}/underpost`;
      if (options.reset === true) {
        shellExec(`sudo systemctl stop snap.lxd.daemon`);
        shellExec(`sudo snap remove lxd --purge`);
      }
      if (options.install === true) shellExec(`sudo snap install lxd`);
      if (options.init === true) {
        shellExec(`sudo systemctl start snap.lxd.daemon`);
        shellExec(`sudo systemctl status snap.lxd.daemon`);
        const lxdPressedContent = fs
          .readFileSync(`${underpostRoot}/manifests/lxd/lxd-preseed.yaml`, 'utf8')
          .replaceAll(`127.0.0.1`, getLocalIPv4Address());
        // shellExec(`lxc profile show admin-profile`);
        // shellExec(`lxc network show lxdbr0`);
        // shellExec(`lxd init --preseed < ${underpostRoot}/manifests/lxd/lxd-preseed.yaml`);
        shellExec(`echo "${lxdPressedContent}" | lxd init --preseed`);
        shellExec(`lxc cluster list`);
      }
      if (options.createVm && typeof options.createVm === 'string') {
        // lxc launch
        const createVmCommand = `lxc init images:rockylinux/9/cloud ${
          options.createVm
        } --vm --target lxd-node1 -c limits.cpu=2 -c limits.memory=4GB --profile admin-profile -d root,size=${
          options.rootSize && typeof options.rootSize === 'string' ? options.rootSize + 'GiB' : '32GiB'
        }`;
        pbcopy(createVmCommand); // Copy the command to clipboard for user
      }
      if (options.startVm && typeof options.startVm === 'string') {
        const vmIp = UnderpostLxd.API.getNextAvailableIp();
        shellExec(`lxc stop ${options.startVm}`);
        shellExec(
          `lxc config set ${options.startVm} user.network-config="${UnderpostLxd.API.generateCloudInitNetworkConfig(
            vmIp,
          )}"`,
        );
        shellExec(`lxc config device override ${options.startVm} eth0`);
        shellExec(`lxc config device set ${options.startVm} eth0 ipv4.address ${vmIp}`);
        shellExec(
          `lxc config set ${options.startVm} user.user-data="#cloud-config
runcmd:
  - [touch, /var/log/userdata-ok]"`,
        );
        shellExec(`lxc start ${options.startVm}`);
      }
      if (options.initVm && typeof options.initVm === 'string') {
        let flag = '';
        if (options.control === true) {
          flag = ' -s -- --kubeadm';
          shellExec(`lxc exec ${options.initVm} -- bash -c 'mkdir -p /home/dd/engine'`);
          shellExec(`lxc file push /home/dd/engine/engine-private ${options.initVm}/home/dd/engine --recursive`);
        } else if (options.worker == true) {
          flag = ' -s -- --worker';
        }
        pbcopy(`cat ${underpostRoot}/manifests/lxd/underpost-setup.sh | lxc exec ${options.initVm} -- bash${flag}`);
      }
      if (options.joinNode && typeof options.joinNode === 'string') {
        const [workerNode, controlNode] = options.joinNode.split(',');
        const token = shellExec(
          `echo "$(lxc exec ${controlNode} -- bash -c 'sudo kubeadm token create --print-join-command')"`,
          { stdout: true },
        );
        shellExec(`lxc exec ${workerNode} -- bash -c '${token}'`);
      }
      if (options.infoVm && typeof options.infoVm === 'string') {
        shellExec(`lxc config show ${options.infoVm}`);
        shellExec(`lxc info --show-log ${options.infoVm}`);
        shellExec(`lxc info ${options.infoVm}`);
        shellExec(`lxc list ${options.infoVm}`);
      }
      if (options.expose && typeof options.expose === 'string') {
        const [controlNode, ports] = options.expose.split(':');
        console.log({ controlNode, ports });
        const protocols = ['tcp', 'udp'];
        const hostIp = getLocalIPv4Address();
        const vmIp = shellExec(
          `lxc list ${controlNode} --format json | jq -r '.[0].state.network.enp5s0.addresses[] | select(.family=="inet") | .address'`,
          { stdout: true },
        ).trim();
        for (const port of ports.split(',')) {
          for (const protocol of protocols) {
            shellExec(`lxc config device remove ${controlNode} ${controlNode}-port-${port}`);
            shellExec(
              `lxc config device add ${controlNode} ${controlNode}-port-${port} proxy listen=${protocol}:${hostIp}:${port} connect=${protocol}:${vmIp}:${port} nat=true`,
            );
            shellExec(`lxc config show ${controlNode} --expanded | grep proxy`);
          }
        }
      }
    },
    generateCloudInitNetworkConfig(ip) {
      return `version: 2
ethernets:
  enp5s0:
    dhcp4: false
    addresses:
      - ${ip}/24
    gateway4: 10.250.250.1
    nameservers:
      addresses: [1.1.1.1, 8.8.8.8]`;
    },
    getUsedIpsFromLxd() {
      const json = shellExec('lxc list --format json', { stdout: true, silent: true });
      const vms = JSON.parse(json);

      const usedIps = [];

      for (const vm of vms) {
        if (vm.state && vm.state.network) {
          for (const iface of Object.values(vm.state.network)) {
            if (iface.addresses) {
              for (const addr of iface.addresses) {
                if (addr.family === 'inet' && addr.address.startsWith('10.250.250.')) {
                  usedIps.push(addr.address);
                }
              }
            }
          }
        }
      }

      return usedIps;
    },
    getNextAvailableIp(base = '10.250.250.', start = 100, end = 254) {
      const usedIps = UnderpostLxd.API.getUsedIpsFromLxd();
      for (let i = start; i <= end; i++) {
        const candidate = `${base}${i}`;
        if (!usedIps.includes(candidate)) {
          return candidate;
        }
      }
      throw new Error('No IPs available in the static range');
    },
  };
}

export default UnderpostLxd;
