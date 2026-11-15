package com.selectra.app;

import android.graphics.Color;
import android.os.Bundle;
import android.view.Window;

import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(SelectraNativePlugin.class);
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        if (window != null) {
            int bg = Color.parseColor("#09090B");
            window.setStatusBarColor(bg);
            window.setNavigationBarColor(bg);
            WindowInsetsControllerCompat controller =
                new WindowInsetsControllerCompat(window, window.getDecorView());
            controller.setAppearanceLightStatusBars(false);
            controller.setAppearanceLightNavigationBars(false);
        }
    }
}
