package com.dimazero.webtabs;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import java.io.BufferedInputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Receives ordered MIDI key events from a paired PC while practice is open. */
final class PianoReceiver extends Thread {
    interface Listener { void event(String kind, int value, String detail); }
    private final ConnectivityManager networks;
    private final String pin;
    private final Listener listener;
    private volatile boolean stopped;
    private ServerSocket server;
    private Socket client;
    private String lastStatus = "";

    PianoReceiver(Context context, String pin, Listener listener) {
        super("web-tabs-piano");
        this.networks = context.getSystemService(ConnectivityManager.class);
        this.pin = pin;
        this.listener = listener;
    }

    private String addresses() {
        String wifi = "", vpn = "";
        for (Network net : networks.getAllNetworks()) {
            NetworkCapabilities caps = networks.getNetworkCapabilities(net);
            LinkProperties link = networks.getLinkProperties(net);
            if (caps == null || link == null) continue;
            for (LinkAddress a : link.getLinkAddresses()) {
                if (!(a.getAddress() instanceof Inet4Address)) continue;
                if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) vpn = "VPN " + a.getAddress().getHostAddress();
                else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) wifi = a.getAddress().getHostAddress();
            }
        }
        if (wifi.isEmpty() && vpn.isEmpty()) return "USB";
        return wifi.isEmpty() ? vpn : vpn.isEmpty() ? wifi : wifi + " / " + vpn;
    }

    synchronized void close() {
        stopped = true;
        interrupt();
        try { if (client != null) client.close(); } catch (IOException ignored) { }
        try { if (server != null) server.close(); } catch (IOException ignored) { }
    }

    private void status(String text) {
        if (!stopped && !text.equals(lastStatus)) {
            lastStatus = text;
            listener.event("status", 0, text);
        }
    }

    public void run() {
        while (!stopped) {
            try {
                listen();
            } catch (IOException e) {
                status("Не удалось открыть вход по Wi-Fi");
            }
            try { Thread.sleep(750); } catch (InterruptedException ignored) { }
        }
    }

    private void listen() throws IOException {
        try (ServerSocket incoming = new ServerSocket()) {
            synchronized (this) {
                if (stopped) return;
                server = incoming;
                incoming.setReuseAddress(true);
                incoming.bind(new InetSocketAddress(5179));
                incoming.setSoTimeout(1200);
            }
            while (!stopped) {
                status("Ожидаю ПК · " + addresses() + " · код " + pin);
                try (Socket peer = incoming.accept()) {
                    InetAddress remote = peer.getInetAddress();
                    if (!(remote.isSiteLocalAddress() || remote.isLinkLocalAddress() || remote.isLoopbackAddress())) continue;
                    synchronized (this) { if (stopped) return; client = peer; }
                    try { receive(peer); } catch (IOException ignored) { /* reconnect */ }
                    finally { if (!stopped) listener.event("reset", 0, ""); }
                } catch (SocketTimeoutException ignored) { /* recheck Wi-Fi */ }
            }
        }
    }

    private void receive(Socket peer) throws IOException {
        peer.setSoTimeout(4000);
        peer.setTcpNoDelay(true);
        DataInputStream input = new DataInputStream(new BufferedInputStream(peer.getInputStream()));
        byte[] expected = ("WTM1:" + pin + "\n").getBytes(StandardCharsets.US_ASCII);
        byte[] hello = new byte[expected.length];
        input.readFully(hello);
        if (!Arrays.equals(hello, expected)) {
            peer.getOutputStream().write(new byte[]{'N', 'O', 10});
            return;
        }
        peer.getOutputStream().write(new byte[]{'O', 'K', 10});
        while (!stopped) {
            int type = input.readUnsignedByte(), key = input.readUnsignedByte(), velocity = input.readUnsignedByte();
            if (key > 127 || velocity > 127) return;
            switch (type) {
                case 0: status("ПК подключён · ожидаю пианино"); break;
                case 1: lastStatus = ""; listener.event("ready", 0, "Пианино подключено через ПК"); break;
                case 2: break;  // heartbeat
                case 0x90: listener.event(velocity == 0 ? "off" : "on", key, Integer.toString(velocity)); break;
                case 0x80: listener.event("off", key, ""); break;
                default: return;
            }
        }
    }
}
