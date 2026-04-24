# 🗺️ Операційний План

## Phase 1: System Reconnaissance
- [x] Scan local subnet 192.168.1.0/24 for active hosts
- [x] Enumerate open ports on discovered hosts
- [x] Identify running services and versions on each host

## Phase 2: Infrastructure Hardening
- [x] Configure UFW firewall with restrictive default rules
- [x] Set up fail2ban for SSH brute-force protection
- [x] Audit and disable unnecessary system services
- [x] Review and harden SSH configuration (sshd_config)

## Phase 3: Monitoring & Alerting
- [x] Deploy lightweight system monitoring (e.g., node_exporter)
- [x] Configure log aggregation from all hosts
- [x] Set up automated alerts for suspicious activity
