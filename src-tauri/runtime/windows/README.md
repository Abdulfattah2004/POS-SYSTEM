Swift Till's x64 executable imports VCRUNTIME140.dll and VCRUNTIME140_1.dll.
The bundle maps these app-local runtime files beside the executable, without
installing or modifying a system-wide runtime on this development computer.

Source: Microsoft Visual Studio 18 Build Tools official redistributables,
VC/Redist/MSVC/14.50.35710/x64/Microsoft.VC145.CRT.
Both original Microsoft Windows Authenticode signatures were Valid when copied.
These are Microsoft redistributables, not Swift Till source or customer data.
Windows 10/11 supplies the Universal CRT. WebView2 remains a Tauri prerequisite.

SHA-256:
vcruntime140.dll: 184146852727a9db4eea06178716bec3cdbb1015c911f6b0f915b184ad7775b2
vcruntime140_1.dll: e6bfb3662ab4b1969a73441dbe35c96d51441b6bff8cf1fe7430bd5b246ca605

Do not replace these with unsigned DLLs or files copied from System32.
For a toolchain update, recheck PE imports, official redistributable signatures,
bundle destinations and native startup before packaging.
