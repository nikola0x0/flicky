# 📘 Hướng Dẫn Chi Tiết Các Tính Năng: DeepBook Predict Playground

Tài liệu này giải thích chi tiết ý nghĩa, cơ chế hoạt động, các tham số đầu vào/đầu ra và hành vi on-chain của từng tính năng trên trang **DeepBook Predict Playground**.

---

## 1. 💼 Tab Manager (Quản Lý Tài Khoản Giao Dịch)

Trong giao thức DeepBook Predict, người dùng không giao dịch trực tiếp bằng số dư trong ví cá nhân. Thay vào đó, mọi tương tác ký quỹ và nắm giữ hợp đồng quyền chọn đều thông qua một thực thể trung gian gọi là **`PredictManager`**.

### 1.1. Create Manager (Tạo tài khoản quản lý)
* **Ý nghĩa**: Khởi tạo một đối tượng shared object `PredictManager` trên blockchain Sui. Đối tượng này đóng vai trò như một "tài khoản phụ" (sub-account) thuộc quyền sở hữu của ví bạn.
* **Cơ chế hoạt động**: Giao thức tạo ra một đối tượng độc lập có mã ID duy nhất. Tất cả dUSDC ký quỹ và các vị thế quyền chọn (cả Range và Binary) bạn mua sẽ được lưu giữ bên trong đối tượng này. Thiết kế này giúp tối ưu phí gas và cho phép các bên thứ ba (ví dụ: keeper) có thể tất toán vị thế thay bạn mà không cần bạn phải ký giao dịch trực tiếp.

### 1.2. Get Active Manager (Truy vấn tài khoản hiện có)
* **Ý nghĩa**: Giúp tìm lại ID của `PredictManager` mà ví của bạn đã tạo trước đó trên on-chain.
* **Cơ chế hoạt động**: Sử dụng hàm `client.getOwnedObjects` để quét các đối tượng thuộc sở hữu của địa chỉ ví hiện tại có kiểu cấu trúc `predict_manager::PredictManager`. Khi tìm thấy, hệ thống sẽ tự động điền ID này vào trường cấu hình giúp bạn không cần lưu trữ thủ công ở local storage hay ghi nhớ mã hex dài.

### 1.3. Deposit dUSDC (Nạp tiền ký quỹ)
* **Ý nghĩa**: Nạp tiền tệ ký quỹ (dUSDC) từ ví cá nhân của bạn vào tài khoản `PredictManager`.
* **Cơ chế hoạt động**: 
  * Rút số lượng dUSDC tương ứng trong ví cá nhân của bạn.
  * Gọi hàm Move call `predict_manager::deposit` để nạp vào số dư khả dụng bên trong `PredictManager`.
  * Tiền ký quỹ này sẽ được sử dụng làm tài sản đảm bảo để thanh toán phí bảo hiểm (premium/cost) khi bạn mua các hợp đồng quyền chọn.

### 1.4. Withdraw dUSDC (Rút tiền ký quỹ)
* **Ý nghĩa**: Rút dUSDC từ số dư khả dụng trong `PredictManager` về lại ví cá nhân.
* **Cơ chế hoạt động**: Gọi hàm Move call `predict_manager::withdraw`. Hệ thống sẽ rút dUSDC ra khỏi manager và chuyển thẳng về địa chỉ ví của chủ sở hữu. Bạn chỉ có thể rút phần tiền nhàn rỗi (không bị khóa làm tài sản thế chấp cho các vị thế đang mở).

---

## 2. 💹 Tab Trading (Giao Dịch Quyền Chọn)

Đây là khu vực cốt lõi để mua (Mint) và bán/tất toán (Redeem) các hợp đồng quyền chọn dựa trên biến động giá của tài sản gốc (ví dụ: BTC/USD).

### 2.1. Range Position (Quyền chọn khoảng giá - Strikes Band)
* **Ý nghĩa**: Đặt cược rằng giá tài sản lúc đáo hạn sẽ nằm trong một khoảng giá xác định $[L, H]$.
* **Cơ chế hoạt động**: 
  * **Lower Strike ($L$)**: Mức giá sàn. Nếu bạn chọn *Neg Infinity*, mức sàn mặc định là `0`.
  * **Higher Strike ($H$)**: Mức giá trần. Nếu bạn chọn *Pos Infinity*, mức trần mặc định là giá trị lớn nhất của $u64$ ($18446744073709551615$).
  * Nếu giá đáo hạn $P_{settle}$ thỏa mãn $L < P_{settle} \le H$, bạn thắng cuộc và nhận về **$1.00$ dUSDC** cho mỗi đơn vị hợp đồng. Nếu nằm ngoài khoảng, hợp đồng vô giá trị ($0$ dUSDC).

### 2.2. Binary Position (Quyền chọn nhị phân - Single Strike Up/Down)
* **Ý nghĩa**: Đặt cược đơn giản xem giá tài sản lúc đáo hạn sẽ nằm trên (**UP**) hay nằm dưới (**DOWN**) một mức giá xác định ($S$).
* **Cơ chế hoạt động**:
  * **🟢 UP (Bullish)**: Đặt cược $P_{settle} > S$. Nếu đúng, nhận về $1.00$ dUSDC/hợp đồng.
  * **🔴 DOWN (Bearish)**: Đặt cược $P_{settle} \le S$. Nếu đúng, nhận về $1.00$ dUSDC/hợp đồng.

### 2.3. Preview Price (Xem trước giá quyền chọn)
* **Ý nghĩa**: Kiểm tra chi phí để mua (Mint Cost) hoặc giá trị thanh lý ước tính (Redeem Payout) của một hợp đồng quyền chọn trước khi thực sự xuống tiền.
* **Cơ chế hoạt động**: Gọi hàm read-only `get_trade_amounts` hoặc `get_range_trade_amounts` thông qua giao dịch giả lập `devInspectTransactionBlock`. Chi phí mua được tính toán tự động dựa trên mô hình định giá quyền chọn Black-Scholes kết hợp với tỷ lệ sử dụng nguồn vốn (utilization rate) của liquidity pool.

### 2.4. Buy (Mint) (Mở vị thế)
* **Ý nghĩa**: Dùng dUSDC từ tài khoản `PredictManager` để mua các hợp đồng quyền chọn mới.
* **Cơ chế hoạt động**: Gọi hàm `predict::mint` hoặc `predict::mint_range`. Số tiền dUSDC tương ứng với phí mua (Mint Cost) sẽ bị trừ khỏi tài khoản manager và chuyển vào Vault dự trữ của giao thức để khóa lại. Đồng thời, một bản ghi vị thế mới được tạo ra trong danh mục của `PredictManager`.

### 2.5. Sell (Redeem) (Đóng/Tất toán vị thế)
* **Ý nghĩa**: 
  * **Trước khi đáo hạn**: Đóng vị thế sớm để chốt lời/cắt lỗ theo giá thị trường hiện tại.
  * **Sau khi đáo hạn**: Settle vị thế để nhận payout đầy đủ ($1.00$ dUSDC/hợp đồng thắng cuộc).
* **Cơ chế hoạt động**: Gọi hàm `predict::redeem` hoặc `predict::redeem_range`. Hệ thống kiểm tra tính hợp lệ của hợp đồng và chuyển số dUSDC (payout) từ Vault dự trữ quay ngược trở lại số dư khả dụng trong `PredictManager` của bạn.

### 2.6. Active Positions Table (Bảng vị thế đang sở hữu)
* **Real-time (On-chain)**: Đọc trực tiếp dữ liệu thô từ cấu trúc cây dynamic fields (`positions` và `range_positions`) của `PredictManager` trên Sui blockchain. Đảm bảo dữ liệu hiển thị chính xác $100\%$ theo thời gian thực.
  * **Nút ✏️ Use**: Nhấp vào nút này sẽ tự động điền toàn bộ thông tin chi tiết của vị thế đó (loại quyền chọn, mã oracle, giá strike, hướng cược và số lượng) vào biểu mẫu giao dịch để bạn có thể bán hoặc tất toán ngay lập tức mà không cần nhập tay.
* **Indexer PnL**: Lấy lịch sử giao dịch từ cơ sở dữ liệu indexer và tính toán chỉ số Profit & Loss (lời/lỗ tạm tính) dựa trên giá thị trường hiện tại.

---

## 3. 💧 Tab LP (Nhà Cung Cấp Thanh Khoản)

Các nhà cung cấp thanh khoản (Liquidity Providers) đóng vai trò là "nhà cái", bỏ vốn đối ứng để chi trả cho các giao dịch thắng cuộc và thu về phí giao dịch từ người mua quyền chọn.

### 3.1. Supply Liquidity (Cung cấp thanh khoản)
* **Ý nghĩa**: Gửi dUSDC từ ví cá nhân vào Vault chung của Predict để tăng độ sâu cho thị trường giao dịch.
* **Cơ chế hoạt động**: Gọi hàm `predict::supply`. Người dùng gửi dUSDC vào và nhận về token **`PLP` (Predict LP Coin)** đại diện cho tỷ lệ sở hữu cổ phần trong pool thanh khoản. Giá trị của PLP tăng lên khi pool thu được phí bảo hiểm và phí giao dịch.

### 3.2. Withdraw Liquidity (Rút thanh khoản)
* **Ý nghĩa**: Đốt token PLP để rút lại dUSDC cùng với lợi nhuận tích lũy về ví cá nhân.
* **Cơ chế hoạt động**: Gọi hàm `predict::withdraw`. Hệ thống sẽ đốt số lượng token PLP bạn gửi lên, tính toán giá trị quy đổi dUSDC hiện tại của pool và chuyển trả dUSDC về ví của bạn.

---

## 4. 🛠️ Tab Keeper (Người Vận Hành Hệ Thống)

Keeper là các tác nhân tự vận hành (thường là bot tự động) giúp duy trì hoạt động trơn tru của giao thức. Trên Playground, các tính năng này được phơi bày ra giao diện để lập trình viên có thể mô phỏng thủ công.

### 4.1. Compact Settled Oracle (Nén dữ liệu Oracle)
* **Ý nghĩa**: Giải phóng dung lượng lưu trữ trên blockchain sau khi một thị trường (oracle) đã kết thúc và tất toán.
* **Cơ chế hoạt động**: Gọi hàm `predict::compact_settled_oracle`. Thao tác này sẽ nén ma trận strike của oracle đã kết thúc thành một kích thước hằng số tối thiểu, giúp tiết kiệm tài nguyên lưu trữ của node mạng và tối ưu hóa hiệu năng hệ thống.

### 4.2. Permissionless Redemption (Tất toán hộ không cần quyền)
* **Ý nghĩa**: Cho phép bất kỳ ai cũng có thể kích hoạt lệnh settle hộ các vị thế của một tài khoản `PredictManager` khác sau khi oracle đáo hạn.
* **Cơ chế hoạt động**: Gọi hàm `predict::redeem_permissionless`. Payout thắng cuộc vẫn sẽ được chuyển tự động vào tài khoản `PredictManager` của **chủ sở hữu** vị thế đó chứ không chạy vào ví của người chạy lệnh hộ. Tính năng này giúp các bot keeper có thể hỗ trợ tất toán tự động hàng loạt cho toàn bộ người dùng trên giao thức.

---

## 5. 🔮 Tab Oracle (Thông Tin Giá & Tham Số)

Oracle là nguồn cấp dữ liệu giá bên ngoài (ví dụ từ mạng Pyth) làm trọng tài quyết định kết quả thắng thua của các quyền chọn.

### 5.1. Spot Price (Giá giao ngay)
* **Ý nghĩa**: Giá hiện tại của tài sản gốc (ví dụ: BTC) được cập nhật liên tục từ Oracle trên blockchain.
* **Cơ chế hoạt động**: Đọc giá trị trực tiếp từ luồng dữ liệu Oracle để xác định giá thị trường thực tế.

### 5.2. BS Forward Price (Giá kỳ hạn Black-Scholes)
* **Ý nghĩa**: Giá dự kiến tương lai của tài sản tại thời điểm đáo hạn, được tính toán thông qua công thức Black-Scholes tích hợp trong smart contract của Predict. Đây là đầu vào cốt lõi để định giá premium cho quyền chọn.

### 5.3. Trạng thái Oracle (Oracle Status)
* **Active**: Thị trường đang mở, người dùng có thể thoải mái Mint (mua) các hợp đồng.
* **PendingSettlement**: Oracle đã đến thời điểm đáo hạn (Expiry) nhưng chưa có dữ liệu giá đóng cửa chính thức để chốt kết quả. Trong trạng thái này, giao dịch Mint bị khóa.
* **Settled**: Đã ghi nhận giá đóng cửa chính thức. Người dùng chỉ có thể thực hiện giao dịch Redeem để rút tiền thắng cược.

### 5.4. Các tham số giao thức (Protocol Configurations)
* **Base Spread & Min Spread**: Khoảng chênh lệch giá sàn/trần tối thiểu mà giao thức áp dụng khi báo giá mua/bán nhằm quản trị rủi ro.
* **Utilization Multiplier**: Hệ số nhân dựa trên tỷ lệ sử dụng pool. Càng nhiều người mua quyền chọn cùng một hướng, pool càng cạn kiệt tài sản đối ứng thì phí bảo hiểm (Mint Cost) hướng đó sẽ tự động tăng lên để điều tiết thị trường.
* **Max Total Exposure Pct**: Tỷ lệ rủi ro tối đa mà pool thanh khoản chấp nhận chịu đựng cho một thị trường oracle nhất định (để tránh trường hợp pool bị vỡ nợ nếu có một biến cố giá cực đoan xảy ra).
