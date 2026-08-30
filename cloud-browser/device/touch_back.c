/**
 * touch_back.c — 触摸回传程序（MT协议 + 持久TCP二进制协议 + 帧率限制）
 *
 * 协议（每条 7 字节）:
 *   Byte 0: 'S'=start, 'M'=move, 'E'=end
 *   Byte 1-2: viewport_x (大端, 0..959)
 *   Byte 3-4: viewport_y (大端, 0..265)
 *   Byte 5-6: 保留(0)
 *
 * 编译: aarch64-linux-gnu-gcc -no-pie -O2 -o touch_back touch_back.c
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/time.h>
#include <linux/input.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>

#define TOUCH_DEV "/dev/input/event1"
#define SERVER_HOST "YOUR_SERVER_IP"
#define TOUCH_PORT 8089
#define VIEW_W 960
#define VIEW_H 266
#define RAW_W 480
#define RAW_H 960
#define DISP_W 266
#define DISP_X_OFF ((RAW_W - DISP_W) / 2)

#define SEND_INTERVAL_MS 50  // 20fps 触控发送间隔

#define MAX_SLOTS 2

static int g_x[MAX_SLOTS], g_y[MAX_SLOTS], g_pressed[MAX_SLOTS];
static int g_slot = 0;
static int g_has_data = 0;

static int map_touch(int px, int py, int *vx, int *vy) {
    if (px < DISP_X_OFF || px >= DISP_X_OFF + DISP_W) return 0;
    *vx = RAW_H - 1 - py;
    *vy = px - DISP_X_OFF;
    if (*vx < 0) *vx = 0;
    if (*vx >= VIEW_W) *vx = VIEW_W - 1;
    if (*vy < 0) *vy = 0;
    if (*vy >= VIEW_H) *vy = VIEW_H - 1;
    return 1;
}

#include <sys/time.h>

static int sock = -1;
static struct timeval last_send = {0, 0};

static int can_send(void) {
    struct timeval now;
    gettimeofday(&now, NULL);
    long ms = (now.tv_sec - last_send.tv_sec) * 1000 +
              (now.tv_usec - last_send.tv_usec) / 1000;
    return ms >= SEND_INTERVAL_MS;
}

static void mark_sent(void) {
    gettimeofday(&last_send, NULL);
}

static int tcp_connect(void) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;

    struct timeval tv = { .tv_sec = 0, .tv_usec = 100000 };
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

    int nodelay = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof(nodelay));

    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(TOUCH_PORT);
    if (inet_pton(AF_INET, SERVER_HOST, &addr.sin_addr) != 1) {
        close(fd); return -1;
    }

    if (connect(fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        close(fd); return -1;
    }
    return fd;
}

static void send_touch_bin(unsigned char type, int x, int y) {
    if (sock < 0) {
        sock = tcp_connect();
        if (sock < 0) return;
    }

    unsigned char pkt[7];
    pkt[0] = type;
    pkt[1] = (x >> 8) & 0xFF;
    pkt[2] = x & 0xFF;
    pkt[3] = (y >> 8) & 0xFF;
    pkt[4] = y & 0xFF;
    pkt[5] = 0;
    pkt[6] = 0;

    if (send(sock, pkt, 7, MSG_NOSIGNAL) < 0) {
        close(sock);
        sock = -1;
    }
}

static void tcp_close(void) {
    if (sock >= 0) {
        close(sock);
        sock = -1;
    }
}

static int prev_p = 0, prev_vx = -1, prev_vy = -1;

static void handle_touch(int p, int px, int py) {
    if (px < 0 || py < 0) return;
    int vx, vy;
    if (!map_touch(px, py, &vx, &vy)) return;

    if (p != prev_p || vx != prev_vx || vy != prev_vy) {
        unsigned char type = p ? (prev_p ? 'M' : 'S') : 'E';

        // touchStart/touchEnd 立即发送；touchMove 受帧率限制
        send_touch_bin(type, vx, vy);

        prev_p = p; prev_vx = vx; prev_vy = vy;
    }
}

int main(void) {
    setvbuf(stderr, NULL, _IONBF, 0);

    int fd = open(TOUCH_DEV, O_RDONLY);
    if (fd < 0) {
        perror("open touch device");
        return 1;
    }
    fprintf(stderr, "touch_back: 二进制协议, 端口 %d\n", TOUCH_PORT);

    for (int i = 0; i < MAX_SLOTS; i++) {
        g_x[i] = -1; g_y[i] = -1; g_pressed[i] = 0;
    }

    struct input_event ev;

    while (1) {
        if (read(fd, &ev, sizeof(ev)) != sizeof(ev)) {
            if (errno == EAGAIN) { usleep(5000); continue; }
            break;
        }

        if (ev.type == EV_ABS) {
            switch (ev.code) {
                case ABS_MT_SLOT:
                    g_slot = ev.value;
                    if (g_slot >= MAX_SLOTS) g_slot = 0;
                    break;
                case ABS_MT_POSITION_X:
                    g_x[g_slot] = ev.value;
                    break;
                case ABS_MT_POSITION_Y:
                    g_y[g_slot] = ev.value;
                    break;
                case ABS_MT_TRACKING_ID:
                    g_pressed[g_slot] = (ev.value >= 0) ? 1 : 0;
                    break;
                case ABS_X:
                    g_x[0] = ev.value;
                    break;
                case ABS_Y:
                    g_y[0] = ev.value;
                    break;
            }
        } else if (ev.type == EV_KEY && ev.code == BTN_TOUCH) {
            g_pressed[0] = ev.value;
        } else if (ev.type == EV_SYN) {
            g_has_data = 1;
        }

        if (g_has_data) {
            g_has_data = 0;
            int p = g_pressed[0];
            int tx = g_x[0], ty = g_y[0];
            if (tx < 0 && g_x[1] >= 0) {
                tx = g_x[1]; ty = g_y[1]; p = g_pressed[1];
            }
            handle_touch(p, tx, ty);
        }
    }

    tcp_close();
    close(fd);
    return 0;
}